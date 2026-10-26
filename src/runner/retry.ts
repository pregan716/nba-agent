import { APIConnectionError } from "@anthropic-ai/sdk";
import { setTimeout as delay } from "node:timers/promises";
import type { RunConfig } from "./config.js";

export function modelError(error: any) {
  const clean = (value: unknown) => {
    let text = String(value ?? "");
    for (const [key, secret] of Object.entries(process.env))
      if (
        /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) &&
        secret &&
        secret.length >= 8
      )
        text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/\b(?:sk-|Bearer\s+)[\w.-]+/gi, "[REDACTED]")
      .replace(
        /((?:api[_-]?key|authorization|token|secret|password)["']?\s*[=:]\s*["']?)[^\s,;"']+/gi,
        "$1[REDACTED]",
      )
      .slice(0, 4096);
  };
  return {
    status: Number.isInteger(error?.status) ? error.status : null,
    type: clean(
      error?.error?.error?.type ??
        error?.error?.type ??
        error?.type ??
        error?.constructor?.name ??
        "Error",
    ),
    requestId:
      clean(
        error?.requestID ??
          error?.request_id ??
          error?.headers?.get?.("request-id") ??
          error?.headers?.["request-id"],
      ) || null,
    message: clean(
      error?.error?.error?.message ??
        error?.error?.message ??
        error?.message ??
        error,
    ),
  };
}
function transient(error: any): boolean {
  if (typeof error?.status === "number")
    return [500, 502, 503, 529, 408].includes(error.status);
  return (
    error instanceof APIConnectionError ||
    ["APIConnectionError", "APIConnectionTimeoutError"].includes(error?.name) ||
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(error?.code ?? error?.cause?.code)
  );
}

/** The deadline bounds retry starts, never an in-flight generation. */
export async function retryModel<T>(
  call: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  config: RunConfig,
  failed: (error: unknown, attempt: number, terminal: boolean) => void,
): Promise<{ value: T; retries: number }> {
  const policy = {
    retries: 3,
    baseMs: 2000,
    capMs: 30000,
    totalMs: 60000,
    ...config.recovery?.model,
  };
  const signal = parent;
  const end = Date.now() + policy.totalMs;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // Parent may already be cancelled before the first provider invocation.
  void aborted.catch(() => {});
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        signal.throwIfAborted();
        const value = await Promise.race([call(signal), aborted]);
        return { value, retries: attempt };
      } catch (error) {
        const wait =
          Math.min(policy.capMs, policy.baseMs * 2 ** attempt) *
          (0.5 + Math.random() * 0.5);
        const terminal =
          signal.aborted ||
          !transient(error) ||
          attempt >= policy.retries ||
          Date.now() + wait >= end;
        if (terminal) {
          failed(error, attempt + 1, true);
          throw error;
        }
        try {
          await delay(wait, undefined, { signal });
        } catch (cancelled) {
          failed(error, attempt + 1, true);
          throw cancelled;
        }
        // A delayed timer/event loop must not start another request past the
        // retry window. Record this failed attempt once with its final outcome.
        const expired = Date.now() >= end;
        failed(error, attempt + 1, expired);
        if (expired) throw error;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
