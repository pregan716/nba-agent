import { randomUUID } from "node:crypto";
import type { RunConfig, Limit, Phase } from "./config.js";
import { RecordStore } from "./record.js";
export class LimitError extends Error {
  constructor(readonly limit: Exclude<Limit, null>) {
    super(`Session limit: ${limit}`);
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
export const tokenTotal = (u: Usage) =>
  u.input + u.output + u.cacheRead + u.cacheWrite;
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
  get stage(): Phase {
    return this.phase === "postgame"
      ? "postgame"
      : this.record.events("commit", this.scope).length
        ? "commit"
        : "pregame";
  }
  commit(): void {
    if (this.phase !== "pregame") throw Error("Cannot commit postgame");
    if (this.stage !== "commit") this.record.append("commit", this.scope, {});
  }
  totals() {
    const events = this.record.events(undefined, this.scope);
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
