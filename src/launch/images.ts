import { execFileSync } from "node:child_process";

/** Local preflight only: never pull an image or start a paid session to test it. */
export function verifyLaunchImages(
  images: { projection: string; sandbox?: string | null },
  inspect: (image: string) => string = (image) =>
    execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
) {
  for (const [role, pin] of Object.entries(images)) {
    if (!pin && role === "sandbox") continue;
    if (!pin || !/@sha256:[a-f0-9]{64}$/.test(pin))
      throw Error(`${role} image must have an immutable digest pin`);
    try {
      const id = inspect(pin.replace(/^local@/, "")).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(id))
        throw Error("Invalid image identity");
      if (pin.startsWith("local@") && id !== pin.slice(6))
        throw Error("Image identity mismatch");
    } catch (cause) {
      throw Error(
        `Cannot resolve pinned ${role} image locally: ${pin}. Ensure Docker is running and build or pull that exact image before launching; no model calls have been started.`,
        { cause },
      );
    }
  }
}
