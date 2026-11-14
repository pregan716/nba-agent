import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../env/tools.js";

export const models = z.enum([
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "jev-1.14.0",
]);
const name = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine((s) => !Object.hasOwn(Object.prototype, s));
const file = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*\.py$/);
// Tool declarations are untrusted. Offer typed arguments without executing
// arbitrary validation expressions or resolving external schema references.
const parameters = z
  .strictObject({
    type: z.literal("object"),
    properties: z.record(
      name,
      z.strictObject({
        type: z.enum([
          "string",
          "number",
          "integer",
          "boolean",
          "object",
          "array",
          "null",
        ]),
        description: z.string().optional(),
      }),
    ),
    required: z.array(name).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .refine(
    (s) => s.required?.every((k) => Object.hasOwn(s.properties, k)) ?? true,
    "Unknown required parameter",
  );
const schema = z.strictObject({
  version: z.literal("game-loop-v1"),
  hypothesis: z.string().min(1),
  entry: file,
  files: z.record(file, z.string()),
  training: z.array(file),
  artifacts: z.record(name, z.enum(["team", "league"])),
  agents: z.record(
    name,
    z.strictObject({
      model: models,
      prompt: z.string().min(1),
      skills: z.array(z.string()),
      tools: z.record(
        name,
        z.strictObject({
          file,
          description: z.string().min(1),
          parameters: parameters.optional(),
        }),
      ),
    }),
  ),
});
export type Package = z.infer<typeof schema>;
export type Specialist = Package["agents"][string];
export function readPackage(raw: unknown) {
  const pkg = schema.parse(raw);
  for (const path of [
    pkg.entry,
    ...pkg.training,
    ...Object.values(pkg.agents).flatMap((a) =>
      Object.values(a.tools).map((t) => t.file),
    ),
  ])
    if (!Object.hasOwn(pkg.files, path))
      throw Error("Missing package file: " + path);
  return {
    pkg,
    hash: createHash("sha256").update(canonicalJson(pkg)).digest("hex"),
  };
}
