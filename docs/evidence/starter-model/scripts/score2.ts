// Score predictions2.json variants with the repo scorer; bootstrap each against A-celtics.
import { readFileSync, writeFileSync } from "node:fs";
import { scoreWindow } from "../../../../src/replay/scoring.js";
import { pinSwapContract } from "../../../../src/replay/swap.js";

const { dev, warm } = JSON.parse(readFileSync(".cache/hazard/datasets.json", "utf8"));
const preds = JSON.parse(readFileSync(process.argv[2] ?? ".cache/hazard/predictions2.json", "utf8"));
const contract = pinSwapContract(warm);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rowsFor = (table: any) =>
  dev.flatMap((d: any) =>
    d.windows
      .filter((w: any) => !w.exclusions.length && w.state && w.actual)
      .map((w: any) => {
        const p = table[w.id];
        const raw = p.swap
          ? { substitution: p.substitution, candidates: p.candidates, swap: p.swap }
          : { substitution: p.substitution, candidates: [] };
        const r = scoreWindow(w, raw, null, contract);
        if (Object.values(r.validation!.questions).some((q: any) => !q.valid)) throw Error("invalid");
        return { gameId: d.gameId, index: dev.indexOf(d) + 1, kind: w.state.stoppage.kind, s: r.scores! };
      }),
  );
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function boot(ra: any[], rb: any[], metric: string) {
  const per = dev.map((d: any) => {
    const xa = ra.filter((x) => x.gameId === d.gameId && x.s[metric] != null);
    const xb = rb.filter((x) => x.gameId === d.gameId && x.s[metric] != null);
    return { n: xa.length, sa: xa.reduce((s, x) => s + x.s[metric], 0), sb: xb.reduce((s, x) => s + x.s[metric], 0) };
  });
  const diff = (ps: any[]) => {
    const n = ps.reduce((s, p) => s + p.n, 0);
    return ps.reduce((s, p) => s + p.sa, 0) / n - ps.reduce((s, p) => s + p.sb, 0) / n;
  };
  const rnd = mulberry32(8542026), ds: number[] = [];
  for (let i = 0; i < 10000; i++) ds.push(diff(per.map(() => per[Math.floor(rnd() * per.length)])));
  ds.sort((x, y) => x - y);
  return `${diff(per).toFixed(3)} [${ds[499].toFixed(3)}, ${ds[9499].toFixed(3)}]`;
}
const rows: Record<string, any[]> = Object.fromEntries(Object.entries(preds).map(([k, v]) => [k, rowsFor(v)]));
const f = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : "—");
const kinds = ["foul", "timeout", "dead_ball_turnover", "between_periods"];
const out: any = {};
console.log("variant".padEnd(24), "timing  mid    meanP  rate | g1-5 g6-10 | set    hit   other | exitLL entLL | skill foul/to/dbt/bp");
for (const [name, rs] of Object.entries(rows)) {
  const s = rs.map((x) => x.s);
  const sub = s.filter((x: any) => x.setLogLoss != null);
  const tim = (xs: any[]) => mean(xs.map((x) => x.s.timing));
  const skill = kinds.map((k) => {
    const xs = rs.filter((x) => x.kind === k);
    const r = mean(xs.map((x) => x.s.outcome));
    return 1 - tim(xs) / (r * (1 - r));
  });
  out[name] = {
    timing: mean(s.map((x: any) => x.timing)),
    mid: tim(rs.filter((x) => x.kind !== "between_periods")),
    meanP: mean(s.map((x: any) => x.probability)),
    rate: mean(s.map((x: any) => x.outcome)),
    g15: tim(rs.filter((x) => x.index <= 5)),
    g610: tim(rs.filter((x) => x.index > 5)),
    set: mean(sub.map((x: any) => x.setLogLoss)),
    hit: mean(sub.map((x: any) => x.candidateHit)),
    other: mean(sub.map((x: any) => x.otherMass)),
    exitLL: mean(sub.map((x: any) => x.exitLogLoss)),
    entryLL: mean(sub.map((x: any) => x.entryLogLoss)),
    skill,
  };
  const o = out[name];
  console.log(
    name.padEnd(24),
    [o.timing, o.mid, o.meanP, o.rate].map(f).join(" "), "|", [o.g15, o.g610].map(f).join(" "), "|",
    [o.set, o.hit, o.other].map(f).join(" "), "|", [o.exitLL, o.entryLL].map(f).join(" "), "|",
    skill.map((x) => x.toFixed(2)).join("/"),
  );
}
const ref = Object.keys(rows)[0];
for (const name of Object.keys(rows).slice(1)) {
  out[name].vsRef = { timing: boot(rows[name], rows[ref], "timing"), set: boot(rows[name], rows[ref], "setLogLoss") };
  console.log(`${name} − ${ref}: timing ${out[name].vsRef.timing}; set ${out[name].vsRef.set}`);
}
writeFileSync(".cache/hazard/scores2.json", JSON.stringify(out, null, 1));
