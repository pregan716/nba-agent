import { TOOL_DEFINITIONS } from "./tools.js";
import { SessionError, type ToolName } from "./contract.js";
import { Temporal } from "@js-temporal/polyfill";

/** Validate the exact P3a JSON-schema subset at the untrusted tool boundary. */
export function validateInput(
  name: string,
  input: unknown,
): asserts name is ToolName {
  const definition = TOOL_DEFINITIONS.find((d) => d.name === name);
  if (!definition) throw new SessionError("invalid_input", "Unknown tool");
  const problems: string[] = [];
  const check = (schema: any, value: any, path: string) => {
    if (schema.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        problems.push(`${path}: expected object`);
        return;
      }
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(value, key))
          problems.push(`${path}.${key}: required`);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key))
          problems.push(`${path}.${key}: unknown field`);
        else check(schema.properties[key], value[key], `${path}.${key}`);
      }
    } else if (schema.type === "array") {
      if (!Array.isArray(value)) {
        problems.push(`${path}: expected array`);
        return;
      }
      if (value.length < (schema.minItems ?? 0))
        problems.push(`${path}: too few items`);
      value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`));
    } else if (
      schema.type === "integer"
        ? !Number.isInteger(value)
        : typeof value !== schema.type
    )
      problems.push(`${path}: expected ${schema.type}`);
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity))
    )
      problems.push(`${path}: outside allowed range`);
    if (typeof value === "string" && value.length < (schema.minLength ?? 0))
      problems.push(`${path}: too short`);
    if (schema.enum && !schema.enum.includes(value))
      problems.push(`${path}: invalid value`);
  };
  check(definition.input_schema, input, "input");
  if (input && typeof input === "object")
    for (const key of ["from", "to"] as const) {
      const value = (input as any)[key];
      if (value !== undefined)
        try {
          Temporal.Instant.from(value);
        } catch {
          problems.push(`${key}: invalid instant`);
        }
    }
  if (problems.length)
    throw new SessionError("invalid_input", "Invalid tool input", problems);
}
