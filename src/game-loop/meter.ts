import type { RecordStore } from "../runner/record.js";

// Jev's input rate is 42 billionths of a dollar per token. Keep reservations
// and settlements in integer units so an exactly exhausted pool stays closed.
const unitsPerUsd = 1_000_000_000;
function units(usd: number) {
  const amount = Math.round(usd * unitsPerUsd);
  if (!Number.isFinite(usd) || usd < 0 || !Number.isSafeInteger(amount))
    throw Error("Invalid dollar amount");
  return amount;
}
export class ReplayMeter {
  private limit: number;
  private settled = 0;
  private reserved = 0;
  constructor(runUsd: number) {
    this.limit = units(runUsd);
  }
  get usd() {
    return this.settled / unitsPerUsd;
  }
  get unresolvedUsd() {
    return this.reserved / unitsPerUsd;
  }
  get available() {
    return Math.max(0, this.limit - this.settled - this.reserved) / unitsPerUsd;
  }
  game(gameUsd: number, record: RecordStore, scope: string) {
    const cap = units(gameUsd);
    let settled = 0,
      reserved = 0;
    const remaining = () =>
      Math.min(
        this.available,
        Math.max(0, cap - settled - reserved) / unitsPerUsd,
      );
    return {
      remaining,
      get usd() {
        return settled / unitsPerUsd;
      },
      get unresolvedUsd() {
        return reserved / unitsPerUsd;
      },
      reserve: (usd: number) => {
        const amount = units(usd);
        if (amount > units(remaining()))
          throw Error("Insufficient model budget");
        const event = record.append("agent_reservation", scope, { usd });
        this.reserved += amount;
        reserved += amount;
        let open = true;
        return (actual: number) => {
          const charge = units(actual);
          if (!open) throw Error("Reservation already settled");
          record.append("agent_settlement", scope, {
            reservation: event.seq,
            reserved: usd,
            actual,
          });
          open = false;
          this.reserved -= amount;
          reserved -= amount;
          this.settled += charge;
          settled += charge;
        };
      },
    };
  }
}
export type GameMeter = ReturnType<ReplayMeter["game"]>;
