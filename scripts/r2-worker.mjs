import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createInterface } from "node:readline";
const [bucket, expectedProject, expectedConfig] = process.argv.slice(2);
const env = process.env;
const endpoint = env.R2_ENDPOINT_URL;
try {
  if (
    ![
      "pm-data-platform",
      "sports-nba-data",
      "sports-text",
      "sports-transcription",
    ].includes(bucket) ||
    !expectedProject ||
    !expectedConfig ||
    env.DOPPLER_PROJECT !== expectedProject ||
    env.DOPPLER_CONFIG !== expectedConfig
  )
    throw Error();
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error();
  for (const key of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])
    if (!env[key] || env[key].trim() !== env[key]) throw Error();
} catch {
  process.exit(1);
}
const client = new S3Client({
  region: "auto",
  endpoint,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
  maxAttempts: 3,
});
for await (const line of createInterface({ input: process.stdin })) {
  const { id, key } = JSON.parse(line);
  try {
    if (
      typeof key !== "string" ||
      key.startsWith("/") ||
      key.split("/").includes("..")
    )
      throw Error();
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(180000) },
    );
    const body = Buffer.from(await response.Body.transformToByteArray());
    process.stdout.write(
      JSON.stringify({ id, body: body.toString("base64") }) + "\n",
    );
  } catch {
    process.stdout.write(JSON.stringify({ id, key, error: true }) + "\n");
  }
}
client.destroy();
