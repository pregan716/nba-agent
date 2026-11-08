// Score hazard-model predictions and the repo baselines with the repo scorer (jev-contract-v2).
import { readFileSync, writeFileSync } from "node:fs";
import { scoreWindow } from "../../../../src/replay/scoring.js";
import { pinSwapContract } from "../../../../src/replay/swap.js";
import { fitSwapBaselines } from "../../../../src/replay/baselines.js";

const { dev, warm, prior } = JSON.parse(
  readFileSync(".cache/hazard/datasets.json", "utf8"),
);
const preds = JSON.parse(readFileSync(".cache/hazard/predictions.json", "utf8"));
const contract = pinSwapContract(warm);
const base = fitSwapBaselines(warm, [...warm, ...prior]);
const predictors: Record<string, (w: any) => unknown> = {
  constant: (w) => base.constant.predict(w.state),
  statistical: (w) => base.statistical.predict(w.state),
};
for (const [name, table] of Object.entries<any>(preds))
  predictors[name] = (w) => {
    const p = table[w.id];
    return p.swap
      ? { substitution: p.substitution, candidates: p.candidates, swap: p.swap }
      : { substitution: p.substitution, candidates: [] };
  };

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const out: any = { sizePrior: contract.sizePrior, predictors: {} };
for (const [name, predict] of Object.entries(predictors)) {
  const perGame: any[] = [];
  const all: any[] = [];
  for (const d of dev) {
    const rs = d.windows
      .filter((w: any) => !w.exclusions.length && w.state && w.actual)
      .map((w: any) => ({ w, r: scoreWindow(w, predict(w), null, contract) }));
    for (const x of rs) {
      const invalid = Object.entries(x.r.validation!.questions)
        .filter(([, v]: any) => !v.valid)
        .map(([k]) => k);
      if (invalid.length) throw Error(`${name} invalid ${invalid} at ${x.w.id}`);
    }
    all.push(...rs);
    perGame.push({ gameId: d.gameId, rows: rs });
  }
  const summary = (rs: any[]) => {
    const s = rs.map((x) => x.r.scores);
    const mid = rs.filter((x) => x.w.state.stoppage.kind !== "between_periods");
    const subs = s.filter((x: any) => x.setLogLoss != null);
    const rate = (xs: any[]) => mean(xs.map((x: any) => x.outcome));
    return {
      n: s.length,
      timing: mean(s.map((x: any) => x.timing)),
      midTiming: mean(mid.map((x) => x.r.scores.timing)),
      meanP: mean(s.map((x: any) => x.probability)),
      rate: rate(s),
      subs: subs.length,
      setLogLoss: mean(subs.map((x: any) => x.setLogLoss)),
      setClips: subs.reduce((a: number, x: any) => a + x.setLogLossClips, 0),
      hitRate: mean(subs.map((x: any) => x.candidateHit)),
      setTop1: mean(subs.map((x: any) => x.setTop1)),
      otherMass: mean(subs.map((x: any) => x.otherMass)),
      exitLogLoss: mean(subs.map((x: any) => x.exitLogLoss)),
      entryLogLoss: mean(subs.map((x: any) => x.entryLogLoss)),
      exitMRR: mean(subs.map((x: any) => x.exitMRR)),
      entryMRR: mean(subs.map((x: any) => x.entryMRR)),
    };
  };
  out.predictors[name] = {
    pooled: summary(all),
    games12: summary(perGame.slice(0, 2).flatMap((g) => g.rows)),
    perGame: perGame.map((g) => ({
      gameId: g.gameId,
      timing: mean(g.rows.map((x: any) => x.r.scores.timing)),
      setLogLoss: (() => {
        const v = g.rows.map((x: any) => x.r.scores.setLogLoss).filter((v: any) => v != null);
        return mean(v);
      })(),
    })),
  };
}
// Per-kind timing skill against a constant at the kind's own dev-game rate (pilot's harder reference).
const kinds = ["foul", "timeout", "dead_ball_turnover", "between_periods"];
const rowsFor = (name: string) =>
  dev.flatMap((d: any) =>
    d.windows
      .filter((w: any) => !w.exclusions.length && w.state && w.actual)
      .map((w: any) => ({
        gameId: d.gameId,
        kind: w.state.stoppage.kind,
        s: scoreWindow(w, predictors[name](w), null, contract).scores!,
      })),
  );
const kindSkill: any = {};
for (const name of ["statistical", "gbm-rolling", "gbm-baseline-protocol"]) {
  const rs = rowsFor(name);
  kindSkill[name] = Object.fromEntries(
    kinds.map((k) => {
      const xs = rs.filter((x: any) => x.kind === k);
      const r = mean(xs.map((x: any) => x.s.outcome));
      return [
        k,
        { n: xs.length, rate: r, skill: 1 - mean(xs.map((x: any) => x.s.timing)) / (r * (1 - r)) },
      ];
    }),
  );
}
out.kindSkill = kindSkill;
// Paired game bootstrap (10,000 resamples, Mulberry32 seed 8542026), A minus B on window-weighted means.
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function boot(a: string, b: string, metric: "timing" | "setLogLoss", games = dev.map((d: any) => d.gameId)) {
  const ra = rowsFor(a), rb = rowsFor(b);
  const per = games.map((g: string) => {
    const xa = ra.filter((x: any) => x.gameId === g && x.s[metric] != null),
      xb = rb.filter((x: any) => x.gameId === g && x.s[metric] != null);
    return {
      n: xa.length,
      sa: xa.reduce((s: number, x: any) => s + x.s[metric], 0),
      sb: xb.reduce((s: number, x: any) => s + x.s[metric], 0),
    };
  });
  const diff = (ps: any[]) =>
    ps.reduce((s, p) => s + p.sa, 0) / ps.reduce((s, p) => s + p.n, 0) -
    ps.reduce((s, p) => s + p.sb, 0) / ps.reduce((s, p) => s + p.n, 0);
  const rnd = mulberry32(8542026), ds: number[] = [];
  for (let i = 0; i < 10000; i++)
    ds.push(diff(per.map(() => per[Math.floor(rnd() * per.length)])));
  ds.sort((x, y) => x - y);
  return { diff: diff(per), lo: ds[499], hi: ds[9499] };
}
out.bootstrap = {
  "gbm-rolling − statistical timing": boot("gbm-rolling", "statistical", "timing"),
  "gbm-rolling − statistical set": boot("gbm-rolling", "statistical", "setLogLoss"),
  "gbm-rolling − constant set": boot("gbm-rolling", "constant", "setLogLoss"),
  "gbm-baseline-protocol − statistical timing": boot("gbm-baseline-protocol", "statistical", "timing"),
};
const first5 = dev.slice(0, 5).map((d: any) => d.gameId);
out.games1to5 = Object.fromEntries(
  ["constant", "statistical", "gbm-rolling", "gbm-baseline-protocol", "logit-rolling"].map((n) => {
    const rs = rowsFor(n).filter((x: any) => first5.includes(x.gameId));
    return [n, { timing: mean(rs.map((x: any) => x.s.timing)), mid: mean(rs.filter((x: any) => x.kind !== "between_periods").map((x: any) => x.s.timing)) }];
  }),
);
console.log(JSON.stringify({ kindSkill: out.kindSkill, bootstrap: out.bootstrap, games1to5: out.games1to5 }, (k, v) => (typeof v === "number" ? +v.toFixed(3) : v), 1));
writeFileSync(".cache/hazard/scores.json", JSON.stringify(out, null, 1));
const fmt = (v: number) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(3));
console.log("sizePrior", contract.sizePrior.map(fmt).join(" "));
console.log(
  "predictor".padEnd(28),
  "timing mid   meanP  set   hit  top1 other exitLL entLL | g1-2 set",
);
for (const [name, v] of Object.entries<any>(out.predictors)) {
  const p = v.pooled;
  console.log(
    name.padEnd(28),
    [p.timing, p.midTiming, p.meanP, p.setLogLoss, p.hitRate, p.setTop1, p.otherMass, p.exitLogLoss, p.entryLogLoss]
      .map(fmt)
      .join(" "),
    "|",
    fmt(v.games12.setLogLoss),
  );
}
