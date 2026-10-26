/** Build once; deployment hosts consume the registry artifact instead of rebuilding. */
export interface SandboxBuildOptions {
  push?: string;
  platform?: string;
}
export type DockerCommand = (args: string[], capture?: boolean) => string;

export function buildSandboxImage(
  options: SandboxBuildOptions,
  docker: DockerCommand,
): string {
  const tag = options.push ?? "nba-agent-sandbox:local";
  let repository: string | undefined;
  if (options.push !== undefined) {
    const match =
      /^([a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(
        tag,
      );
    if (
      !match ||
      (!/[.:]/.test(tag.split("/")[0]) && tag.split("/")[0] !== "localhost")
    )
      throw Error("--push requires an explicit registry/repository:tag");
    repository = match[1];
  }
  if (
    options.platform !== undefined &&
    !/^linux\/(amd64|arm64)(\/v[0-9]+)?$/.test(options.platform)
  )
    throw Error("--platform must name one Linux amd64 or arm64 platform");
  const platform = options.platform ? ["--platform", options.platform] : [];
  docker(["build", ...platform, "--tag", tag, "sandbox"]);
  const id = docker(
    ["image", "inspect", tag, "--format", "{{.Id}}"],
    true,
  ).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw Error("Invalid built image ID");
  if (!repository) return `local@${id}`;

  // Use the digest reported by this successful push, not a stale RepoDigests entry.
  const pushed = docker(["push", tag], true);
  const digests = new Set(
    [...pushed.matchAll(/\bdigest:\s*(sha256:[a-f0-9]{64})\b/g)].map(
      (m) => m[1],
    ),
  );
  if (digests.size !== 1)
    throw Error("Push did not report one registry manifest digest");
  const image = `${repository}@${[...digests][0]}`;
  docker(["pull", ...platform, image]);
  const pulled = docker(
    ["image", "inspect", image, "--format", "{{.Id}}"],
    true,
  ).trim();
  if (pulled !== id)
    throw Error("Registry digest does not identify the built image");
  return image;
}
