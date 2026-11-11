// Ridge logistic regression with an unpenalized intercept, using Newton steps
// on the training props only. The small positive penalty bounds separated fits.
import { clip, type ScoredProp } from "./market.js";
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) =>
  x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
const logLoss = (score: number, y: number) =>
  Math.max(score, 0) - y * score + Math.log1p(Math.exp(-Math.abs(score)));
const dot = (a: number[], b: number[]) =>
  a.reduce((s, x, i) => s + x * b[i], 0);
function fit(rows: ScoredProp[], blend: boolean) {
  const features = (r: ScoredProp) =>
    blend
      ? [1, logit(clip(r.market)), logit(r.over)]
      : [1, logit(clip(r.market))];
  const xs = rows.map(features),
    n = blend ? 3 : 2,
    successes = rows.reduce((s, r) => s + r.y, 0);
  const beta = Array<number>(n).fill(0);
  beta[0] = Math.log((successes + 0.5) / (rows.length - successes + 0.5));
  if (successes > 0 && successes < rows.length) {
    for (let iter = 0; iter < 100; iter++) {
      const grad = beta.map((b, k) => (k ? b : 0));
      const h = beta.map((_, j) =>
        beta.map((_, k) => Number(j === k && k !== 0)),
      );
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i],
          p = sigmoid(dot(beta, x));
        for (let j = 0; j < n; j++) {
          grad[j] += x[j] * (p - rows[i].y);
          for (let k = 0; k < n; k++) h[j][k] += x[j] * x[k] * p * (1 - p);
        }
      }
      // Gaussian elimination on the positive definite Hessian.
      for (let j = 0; j < n; j++) {
        const pivot = h[j][j];
        for (let k = j; k < n; k++) h[j][k] /= pivot;
        grad[j] /= pivot;
        for (let k = 0; k < n; k++)
          if (k !== j) {
            const scale = h[k][j];
            grad[k] -= scale * grad[j];
            for (let l = j; l < n; l++) h[k][l] -= scale * h[j][l];
          }
      }
      const norm = Math.max(...grad.map(Math.abs));
      for (let j = 0; j < n; j++) beta[j] -= grad[j] / Math.max(1, norm / 2);
      if (norm < 1e-9) break;
    }
  }
  return (r: ScoredProp) => dot(beta, features(r));
}
export function heldOutBlend(rows: ScoredProp[]) {
  const played = rows.filter((r) => r.played);
  const losses = new Map<
    ScoredProp,
    {
      market: number;
      blend: number;
      marketPrediction: number;
      blendPrediction: number;
    }
  >();
  for (const id of new Set(played.map((r) => r.gameId))) {
    const train = played.filter((r) => r.gameId !== id);
    if (!train.length) continue;
    const market = fit(train, false),
      both = fit(train, true);
    for (const row of played.filter((r) => r.gameId === id)) {
      const m = market(row),
        b = both(row);
      losses.set(row, {
        market: logLoss(m, row.y),
        blend: logLoss(b, row.y),
        marketPrediction: sigmoid(m),
        blendPrediction: sigmoid(b),
      });
    }
  }
  return losses;
}
