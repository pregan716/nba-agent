# AWS deployment prerequisites (SPO-822)

These steps prepare an existing AWS Linux host and persistent volume. They do not
provision AWS resources or approve a scored run. The existing budget, contamination
probe, host declaration and checkpoint requirements in [P4](p4-runner.md) still apply.
Use the same checkout/code revision, data pins, image pin and run configuration on
all hosts participating in a run.

## Publish once and reuse the registry digest

Authenticate Docker to the chosen registry first. Build for the AWS host architecture
(on a matching builder or with cross-platform build support). For example, replace
this registry/repository with your provisioned ECR or other registry destination:

```sh
npm run sandbox:build -- --push=registry.example.com/nba-agent/sandbox:release-1 --platform=linux/amd64
```

The command builds and pushes that tag, extracts the manifest digest from the
successful push, pulls the digest and checks its image ID against the built image.
If the push output omits the classic digest line, it queries the remote tag using
`docker buildx imagetools inspect --format '{{json .Manifest}}'` and reads the
structured `digest` field. Buildx is required for this fallback; missing/malformed
registry data or a pulled image that differs from the build fails without updating
the pin. An ambiguous push digest also fails.
It prints `registry.example.com/nba-agent/sandbox@sha256:…` and atomically records
`{"image":"registry.example.com/nba-agent/sandbox@sha256:…"}` in
`.cache/sandbox-image.json`. A failure does not replace an existing pin. Keep this
file with the deployment artifacts. Do not use the mutable tag or the local image
ID as the AWS harness pin, and do not rebuild on each host. The no-argument local
build workflow still writes `local@sha256:…` for local development.

On each deployment host, install the exact saved pin file at
`<checkout>/.cache/sandbox-image.json`, authenticate to the registry, then run from
the checkout:

```sh
SANDBOX_PIN=$(node -p 'JSON.parse(require("node:fs").readFileSync(".cache/sandbox-image.json", "utf8")).image')
docker pull "$SANDBOX_PIN"
docker image inspect "$SANDBOX_PIN"
npm run test:sandbox
```

Use Linux hosts matching the build platform, with Docker, cgroup v2 and `/dev/fuse`
as described in [P3](p3-sandbox.md). The launcher reads the saved pin for `--code`;
verify `harness.sandboxImage` in the generated run configuration is that registry
reference. The sandbox does not pull images during budgeted execution. Reusing the
image avoids host-specific rebuild identities; other harness fields (including
code revision, prompts and loop parameters) must also match for equal versions.

Docker documents [pushing images](https://docs.docker.com/reference/cli/docker/image/push/)
and [pulling an immutable digest](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier).

Before the first AWS pilot, record `docker version`,
`docker info --format '{{json .DriverStatus}}'`, `docker buildx version` and the target
platform with one successful live publish to the selected registry and a digest
pull on a deployment host. The implementation tests use simulated Docker responses;
no AWS builder/store configuration or live ECR push has yet been validated here.
The build-host pull verifies identity but may reuse local layers; each deployment
host must independently pull by digest.

For a cross-architecture builder, follow Docker's [Buildx/QEMU setup](https://docs.docker.com/build/building/multi-platform/).
Use a builder that loads the single-platform build into the local Docker image
store (the default Docker builder does this); this workflow inspects that local
image before pushing. A custom `docker-container` builder without local loading
is not a drop-in replacement. See also the [structured registry inspection API](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/#json-output).

## Put the shard cache on the persistent volume and prewarm it

Use a per-host EBS-backed persistent volume by default and prewarm each host's
cache. If choosing a shared EFS cache, prewarm it once before starting the run hosts;
concurrent cold builds would duplicate work despite UUID staging and atomic rename.
Neither volume setup is provisioned or validated by these scripts. Mount the volume
before setup, and ensure the service user can write to it. Set an absolute path in the environment used by **both** prewarming and the run
service; an interactive shell export alone does not configure a service:

```sh
export NBA_HISTORY_EXPORT_CACHE=/mnt/nba-agent/history-export-v2
mkdir -p "$NBA_HISTORY_EXPORT_CACHE"
doppler run --project nba-agent --config prd -- npx tsx scripts/export-benchmark.ts "$NBA_HISTORY_EXPORT_CACHE" 82
```

The benchmark logs the resolved shard-cache directory and measures a first pass
and a warm pass at game 82 postgame. This warms the prior-season and current-season
released game shards without starting a runner or spending an agent's budget.
Complete it successfully before any budgeted run. Retain its timings, shard counts
and size output with deployment validation. Keep the same absolute environment
value when launching, for example:

```sh
doppler run --project nba-agent --config prd -- npm run launch -- --mode=analyst --memory=season --purpose=pilot --run-id=aws-pilot --code --root=/mnt/nba-agent/runs
```

The environment selects operational storage only; it does not enter the run or
harness identity. Cache keys still bind dataset versions, game identity and export
format. Re-prewarm after changing those inputs or after code changes to the game
envelope or export projection. In particular, PR #26 added `status` to game envelopes
and invalidated keys warmed before that revision. Existing compatible cached shards
are reused. Check the mount is present after restart before running: creating a
path on the root filesystem is not proof that a persistent volume is mounted.

`corpusSource` defaults to `.cache/history-export-v2` resolved from the checkout.
`NBA_HISTORY_EXPORT_CACHE` overrides that default. The benchmark's positional cache
path takes precedence over the environment; with neither, it keeps its isolated
cold-cache benchmark behavior. Environment paths must be absolute; relative values
are rejected rather than silently selecting storage under the checkout. Explicit
benchmark paths may be relative. Empty paths are rejected. The first pass is labeled
“configured shard cache” when a cache was selected, which does not imply it was warm.

Warm caches do not remove per-session shard copying or evidence-table construction.
That setup still counts against the existing wall budget; no timer or run semantics
change here. Measure it on the AWS host before approving budgets. The verified
object cache remains `.cache/objects`, separate from the shard cache.
