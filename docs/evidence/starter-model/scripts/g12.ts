import { readFileSync } from "node:fs";
import { scoreWindow } from "../../../../src/replay/scoring.js";
import { pinSwapContract } from "../../../../src/replay/swap.js";
const { dev, warm } = JSON.parse(readFileSync(".cache/hazard/datasets.json", "utf8"));
const preds = JSON.parse(readFileSync(".cache/hazard/predictions2.json", "utf8"));
const c = pinSwapContract(warm);
for (const name of ["A-celtics", "E-league-teamrate-bos5"]) {
  const s = dev.slice(0, 2).flatMap((d: any) => d.windows.filter((w: any) => !w.exclusions.length && w.state && w.actual).map((w: any) => {
    const p = preds[name][w.id];
    return scoreWindow(w, p.swap ? { substitution: p.substitution, candidates: p.candidates, swap: p.swap } : { substitution: p.substitution, candidates: [] }, null, c).scores!;
  })).filter((x: any) => x.setLogLoss != null);
  const m = (k: string) => (s.reduce((a: number, x: any) => a + x[k], 0) / s.length).toFixed(3);
  console.log(name, "games1-2 n", s.length, "set", m("setLogLoss"), "hit", m("candidateHit"), "other", m("otherMass"));
}
