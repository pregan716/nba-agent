import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Bootstrap marks EC2 hosts. Read live IMDSv2 metadata so a resized or
// replacement instance never inherits the previous instance's identity.
export async function launchMachine() {
  let instanceType = "local";
  if (existsSync("/etc/nba-agent-ec2")) {
    const metadata = "http://169.254.169.254/latest";
    const token = await fetch(metadata + "/api/token", {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(3000),
    });
    if (!token.ok) throw Error("EC2 metadata token unavailable");
    const response = await fetch(metadata + "/meta-data/instance-type", {
      headers: { "X-aws-ec2-metadata-token": await token.text() },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw Error("EC2 instance type unavailable");
    instanceType = (await response.text()).trim();
    if (!/^[\w-]+\.[\w-]+$/.test(instanceType))
      throw Error("Invalid EC2 instance type");
  }
  const [architecture, cpus, memory] = execFileSync(
    "docker",
    ["info", "--format", "{{.Architecture}} {{.NCPU}} {{.MemTotal}}"],
    { encoding: "utf8", timeout: 10000 },
  )
    .trim()
    .split(/\s+/);
  const dockerCpus = Number(cpus);
  const dockerMemoryBytes = Number(memory);
  if (
    !architecture ||
    ![dockerCpus, dockerMemoryBytes].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw Error("Docker did not report its available CPU and memory");
  return { instanceType, architecture, dockerCpus, dockerMemoryBytes };
}
