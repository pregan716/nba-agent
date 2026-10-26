import { randomUUID } from "node:crypto";
import type { RunConfig, Limit, Phase } from "./config.js";
import { RecordStore } from "./record.js";
import { SessionError } from "../env/contract.js";
export class LimitError extends SessionError {
  constructor(readonly limit: Exclude<Limit, null>) {
    super("budget_exhausted", `Session limit: ${limit}`);
  }
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  reasoning: number | null;
}
export function normalizeUsage(raw: any): Usage {
  const count = (v: unknown) => {
    if (!Number.isSafeInteger(v) || (v as number) < 0)
      throw Error("Invalid SDK usage");
    return v as number;
  };
  const cacheWrite = count(raw.cache_creation_input_tokens ?? 0);
  const cacheWrite1h = count(
    raw.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  );
  const cacheWrite5m = count(
    raw.cache_creation?.ephemeral_5m_input_tokens ?? cacheWrite - cacheWrite1h,
  );
  if (cacheWrite1h + cacheWrite5m !== cacheWrite)
    throw Error("Invalid cache usage breakdown");
  return {
    input: count(raw.input_tokens),
    output: count(raw.output_tokens),
    cacheRead: count(raw.cache_read_input_tokens ?? 0),
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    reasoning:
      raw.reasoning_tokens == null ? null : count(raw.reasoning_tokens),
  };
}
/** Tokens charged against the caps. Cache reads count at `cacheReadWeight`
 * (SPO-814): re-reading cached history is not new research, so the cap tracks
 * what the agent spends rather than what the API re-reads. */
export const tokenTotal = (u: Usage, cacheReadWeight = 1) =>
  u.input + u.output + u.cacheWrite + Math.round(u.cacheRead * cacheReadWeight);
/** Preflight estimate of the charged input for a request of `count` tokens when the
 * previous request in the same scope counted `previous`: the prefix up to the
 * previous request is assumed cached, the growth is new. */
export const chargedInputEstimate = (
  count: number,
  previous: number,
  cacheReadWeight: number,
) => {
  const cached = Math.min(count, previous);
  return count - cached + Math.round(cached * cacheReadWeight);
};
export function cost(u: Usage, price: RunConfig["budget"]["price"]): number {
  return (
    (u.input * price.inputPerMillion +
      u.output * price.outputPerMillion +
      u.cacheRead * price.cacheReadPerMillion +
      u.cacheWrite5m * price.cacheWrite5mPerMillion +
      u.cacheWrite1h * price.cacheWrite1hPerMillion) /
    1e6
  );
}
export class Budget {
  readonly caps: RunConfig["budget"]["pregame"];
  constructor(
    readonly record: RecordStore,
    readonly scope: string,
    readonly config: RunConfig,
    readonly phase: "pregame" | "postgame",
  ) {
    this.caps = config.budget[phase];
  }
  events(kind?: string) {
    const since =
      this.record.events("attempt_budget_reset", this.scope).at(-1)?.seq ?? 0;
    return this.record.events(kind, this.scope).filter((e) => e.seq > since);
  }
  get stage(): Phase {
    return this.phase === "postgame"
      ? "postgame"
      : this.events("commit").length
        ? "commit"
        : "pregame";
  }
  commit(): void {
    if (this.phase !== "pregame") throw Error("Cannot commit postgame");
    if (this.stage !== "commit") this.record.append("commit", this.scope, {});
  }
  totals() {
    const events = this.events();
    let tokens = 0,
      compute = 0,
      tools = 0;
    for (const e of events) {
      if (e.kind === "tool_start") tools++;
      if (e.kind !== "reservation") continue;
      const result = events.find(
        (x) => x.kind === "settlement" && x.data.id === e.data.id,
      );
      tokens += result ? result.data.tokens : e.data.tokens;
      compute += result ? result.data.compute : e.data.compute;
    }
    return { tokens, compute, tools };
  }
  remaining() {
    const used = this.totals(),
      reserve =
        this.stage === "pregame" ? this.config.budget.submissionReserve : 0;
    return {
      tokens: Math.max(0, this.caps.tokens - reserve - used.tokens),
      compute: Math.max(0, this.caps.computeSeconds - used.compute),
      tools: Math.max(0, this.caps.toolCalls - used.tools),
      reserve,
      warning:
        this.caps.tokens - reserve - used.tokens <=
        this.config.budget.warnRemainingTokens,
    };
  }
  block(limit: Exclude<Limit, null>): never {
    this.record.append("limit", this.scope, { limit, stage: this.stage });
    throw new LimitError(limit);
  }
  reserve(tokens: number, compute: number, kind: string): string {
    const remaining = this.remaining();
    if (tokens > remaining.tokens)
      this.block(this.stage === "pregame" ? "research_tokens" : "tokens");
    if (compute > remaining.compute) this.block("compute");
    const id = randomUUID();
    this.record.append("reservation", this.scope, {
      id,
      tokens,
      compute,
      kind,
      stage: this.stage,
    });
    return id;
  }
  settle(id: string, tokens: number, compute: number, details: unknown): void {
    if (
      this.record.events("settlement", this.scope).some((e) => e.data.id === id)
    )
      throw Error("Already settled");
    this.record.append("settlement", this.scope, {
      id,
      tokens,
      compute,
      details,
    });
    if (this.totals().tokens > this.caps.tokens) this.block("tokens");
    if (
      this.stage === "pregame" &&
      this.totals().tokens >
        this.caps.tokens - this.config.budget.submissionReserve
    )
      this.block("research_tokens");
    if (this.totals().compute > this.caps.computeSeconds) this.block("compute");
  }
  tool(name: string, args: unknown): void {
    if (this.remaining().tools === 0) this.block("tool_calls");
    this.record.append("tool_start", this.scope, { name, args });
  }
}
