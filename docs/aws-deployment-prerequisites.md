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
as described in [P3](p3-sandbox.md). Pass the saved pin as the sandbox argument to `forecast:run`;
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

## Put the shard cache on the persistent volume

Mount the volume and give the run user write access. Set the same absolute directory in the environment of every forecast run that should reuse the released game shards.

```sh
export NBA_HISTORY_EXPORT_CACHE=/mnt/nba-agent/history-export-v2
mkdir -p "$NBA_HISTORY_EXPORT_CACHE"
```

The forecast environment fills the cache as games become eligible. Cache keys bind the dataset versions, game identity and export format. The verified object cache lives separately under `.cache/objects`. For the launcher arguments and image pins, see [Running the forecast arms](v4/forecast-arms.md).
