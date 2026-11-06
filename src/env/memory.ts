import { z } from "zod";

const rights = z.strictObject({
  read: z.boolean(),
  create: z.boolean(),
  revise: z.boolean(),
});
export const REPRESENTATIONS = [
  "episodic-store-v1",
  "synthesised-profile-v1",
  "free-form-profile-v1",
  "hypothesis-ledger-v1",
  "coach-profile-v1",
  "coach-and-player-profiles-v1",
] as const;
export const MANAGEMENT = [
  "append-only-v1",
  "revision-v1",
  "periodic-consolidation-v1",
  "always-in-context-v1",
  "retrieval-v1",
] as const;
export const SECOND_STAGE = [...REPRESENTATIONS, ...MANAGEMENT] as const;
export const memoryV3Schema = z.strictObject({
  version: z.literal("memory-permissions-v1"),
  variant: z.enum(["M0", "M1", "M2", "M3", "M4"]),
  coachProfile: rights,
  bestPractices: rights,
  skills: rights,
  representation: z.enum(REPRESENTATIONS).optional(),
  management: z.enum(MANAGEMENT).optional(),
  // Explicitly reject mixing v2 switches into a v3 profile.
  horizon: z.never().optional(),
  windowGames: z.never().optional(),
  revision: z.never().optional(),
  process: z.never().optional(),
});
export type MemoryPermissions = z.infer<typeof memoryV3Schema>;
export function memoryVariant(
  variant: MemoryPermissions["variant"],
): MemoryPermissions {
  const gate = (on: boolean) => ({ read: on, create: on, revise: on });
  return {
    version: "memory-permissions-v1",
    variant,
    coachProfile: gate(["M1", "M3", "M4"].includes(variant)),
    bestPractices: gate(["M2", "M3", "M4"].includes(variant)),
    skills: gate(variant === "M4"),
  };
}
export function isMemoryV3(memory: {
  version?: string;
}): memory is MemoryPermissions {
  return memory.version === "memory-permissions-v1";
}
export function validateMemory(memory: MemoryPermissions) {
  if (memory.representation || memory.management)
    throw Error("Second-stage memory values are named but not runnable");
  const expected = memoryVariant(memory.variant);
  for (const gate of ["coachProfile", "bestPractices", "skills"] as const)
    for (const right of ["read", "create", "revise"] as const)
      if (memory[gate][right] !== expected[gate][right])
        throw Error(
          `Memory rights differ from ${memory.variant}: ${gate}.${right}`,
        );
}
export const MEMORY_TOKEN_CAP = 50_000;
