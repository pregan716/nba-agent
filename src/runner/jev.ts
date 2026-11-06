import { setTimeout as delay } from "node:timers/promises";
import type { RecordStore } from "./record.js";
import {
  JEV_MODEL,
  JEV_SETTINGS,
  contextGuard,
  type JevRequest,
} from "../policy/request.js";
export interface JevProvider {
  create(request: JevRequest, signal: AbortSignal): Promise<unknown>;
}
export class JevHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
    readonly retryAfter: string | null,
  ) {
    super(`System One HTTP ${status}`);
  }
}
/** Instantiate only in the trusted runner, never the research harness or assembler. */
export function systemOneProvider(apiKey: string): JevProvider {
  if (!apiKey) throw Error("TYPESAFE_API_KEY is required");
  return {
    async create(request, signal) {
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { unparsed: text.slice(0, 4096) };
      }
      if (!response.ok)
        throw new JevHttpError(
          response.status,
          body,
          response.headers.get("retry-after"),
        );
      return body;
    },
  };
}
export async function meteredJev(
  provider: JevProvider,
  request: JevRequest,
  record: RecordStore<any>,
  scope: string,
  signal: AbortSignal,
) {
  if (request.model !== JEV_MODEL) throw Error("Unpinned Jev request");
  contextGuard(request);
  const start = performance.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    record.append("jev_request", scope, {
      role: "jev",
      attempt,
      request,
      settings: JEV_SETTINGS,
    });
    let raw: any;
    try {
      raw = await provider.create(
        request,
        AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      );
    } catch (error) {
      const retry =
        !signal.aborted &&
        attempt === 0 &&
        ((error instanceof JevHttpError && error.status === 429) ||
          error instanceof TypeError ||
          (error instanceof Error &&
            ["TimeoutError", "AbortError"].includes(error.name)));
      record.append("jev_error", scope, {
        role: "jev",
        attempt,
        retry,
        status: error instanceof JevHttpError ? error.status : null,
        detail:
          error instanceof JevHttpError ? error.detail : "Transport failure",
        latencyMs: performance.now() - start,
      });
      if (!retry) throw error;
      const header = error instanceof JevHttpError ? error.retryAfter : null;
      const seconds = header === null ? NaN : Number(header);
      const ms =
        header === null
          ? 1000
          : Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : Math.max(0, Date.parse(header) - Date.now());
      if (Number.isFinite(ms) && ms > JEV_SETTINGS.maxRetryAfterMs) {
        record.append("jev_error", scope, {
          role: "jev",
          attempt,
          retry: false,
          detail: "Retry-After exceeds 60-second wait cap",
        });
        throw error;
      }
      await delay(Number.isFinite(ms) ? ms : 1000, undefined, { signal });
      continue;
    }
    const usage = raw?.usage;
    const validUsage =
      Number.isSafeInteger(usage?.input_tokens) &&
      usage.input_tokens >= 0 &&
      Number.isSafeInteger(usage?.output_tokens) &&
      usage.output_tokens >= 0;
    const validModel = raw?.model === JEV_MODEL;
    const result = {
      response: raw,
      usage: validUsage ? usage : null,
      usd: validUsage
        ? (usage.input_tokens * JEV_SETTINGS.inputUsdPerMillion) / 1e6
        : null,
      latencyMs: performance.now() - start,
      attempt,
      modelValid: validModel,
      usageValid: validUsage,
    };
    record.append("jev_response", scope, { role: "jev", ...result });
    if (!validModel || !validUsage)
      throw Error(
        !validModel ? "Jev response model mismatch" : "Invalid Jev usage",
      );
    return result;
  }
  throw Error("Jev retry exhausted");
}
