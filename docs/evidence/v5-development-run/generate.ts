import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { archiveRun } from "../../../src/evaluation/service/archive.js";
import {
  pairedComparison,
  summarize,
} from "../../../src/evaluation/service/scores.js";
const [pool, late, out] = process.argv.slice(2);
const headline = (root: string, id: string) => {
  const { scores, forecasts, hash } = archiveRun(join(root, "development", id));
  const c = pairedComparison(scores, scores, "reference");
  const pick = (o: any) =>
    Object.fromEntries(
      [
        "minutes.pinball",
        "fantasy_points.pinball",
        "playBrier",
        "minutes.coverage80",
        "ceiling.hitRate",
      ].map((k) => [k, o[k]]),
    );
  return {
    hash,
    games: c.games,
    teamGames: c.teamGames,
    excluded: scores.filter((s) => s.score.status === "excluded").length,
    fallbacks: forecasts.filter((f) => f.fallback).length,
    system: pick(summarize(scores, "agent").overall),
    reference: pick(summarize(scores, "reference").overall),
    ratios: Object.fromEntries(
      Object.entries(c.metrics).map(([k, v]: any) => [
        k,
        { ratio: v.ratio, ratio90: v.ratio90 },
      ]),
    ),
    guardrailFlag: c.guardrailFlag,
  };
};
const a = new DatabaseSync(join(pool, "architect.sqlite"), { readOnly: true });
const e = new DatabaseSync(join(pool, "evaluations.sqlite"), {
  readOnly: true,
});
const r = new DatabaseSync(join(pool, "reviews.sqlite"), { readOnly: true });
const iterations = a
  .prepare(
    "SELECT id,started,status,spent*1e-9 AS architectUsd FROM iterations ORDER BY rowid",
  )
  .all()
  .map((it: any) => ({
    ...it,
    requests: Number(
      a
        .prepare(
          "SELECT count(*) AS n FROM events WHERE iteration=? AND kind='message' AND json_extract(data,'$.role')='assistant'",
        )
        .get(it.id)!.n,
    ),
    submissions: a
      .prepare(
        "SELECT data FROM events WHERE iteration=? AND kind='decision' ORDER BY seq",
      )
      .all(it.id)
      .map((d: any) => JSON.parse(d.data)),
  }));
const runs = e
  .prepare("SELECT id,kind,parent,hash,status FROM runs ORDER BY rowid")
  .all()
  .map((run: any) =>
    run.kind === "test" ? run : { ...run, ...headline(pool, run.id) },
  );
const nominee = e.prepare("SELECT nominee FROM settings").get()!.nominee;
writeFileSync(
  join(out, "run.json"),
  JSON.stringify(
    {
      pool: ".cache/spo908-opus55",
      nominee,
      iterations,
      hypotheses: a
        .prepare("SELECT name,closed,description FROM hypotheses")
        .all(),
      runs,
      reviews: r
        .prepare(
          "SELECT id,created,hash,verdict,reviewerVerdict,reviewerUsd FROM reviews ORDER BY rowid",
        )
        .all(),
      comparisons: Object.fromEntries(
        [
          [
            "iteration4_vs_iteration2_midseason",
            "4abbd0ba-e5ae-4d8f-8147-327feea9fbeb",
            "fbfb2fbe-ba5e-44f7-8cf9-a241bd6a31fb",
          ],
          [
            "iteration2_vs_iteration1_midseason",
            "fbfb2fbe-ba5e-44f7-8cf9-a241bd6a31fb",
            "9d3e391b-feab-4348-bf76-ea0690c14148",
          ],
        ].map(([name, l, rr]) => {
          const c = pairedComparison(
            archiveRun(join(pool, "development", l)).scores,
            archiveRun(join(pool, "development", rr)).scores,
          );
          return [
            name,
            Object.fromEntries(
              Object.entries(c.metrics).map(([k, v]: any) => [
                k,
                { ratio: v.ratio, ratio90: v.ratio90 },
              ]),
            ),
          ];
        }),
      ),
    },
    null,
    2,
  ) + "\n",
);
const l1 = "5fe52e44-2132-4c40-b55b-003039ef7e86",
  l4 = "dfed2934-03ff-4069-9cc7-888ee52d8ab3";
const c = pairedComparison(
  archiveRun(join(late, "development", l4)).scores,
  archiveRun(join(late, "development", l1)).scores,
);
writeFileSync(
  join(out, "operator-late-checks.json"),
  JSON.stringify(
    {
      pool: ".cache/spo908-latecheck (copy of the pool after iteration 4; not visible to the architect)",
      iteration1: {
        run: l1,
        parent: "9d3e391b-feab-4348-bf76-ea0690c14148",
        ...headline(late, l1),
      },
      iteration4: {
        run: l4,
        parent: "4abbd0ba-e5ae-4d8f-8147-327feea9fbeb",
        ...headline(late, l4),
      },
      iteration4_vs_iteration1: Object.fromEntries(
        Object.entries(c.metrics).map(([k, v]: any) => [
          k,
          { ratio: v.ratio, ratio90: v.ratio90 },
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);
const pkg = JSON.parse(
  String(e.prepare("SELECT pkg FROM runs WHERE id=?").get(nominee)!.pkg),
);
for (const [f, t] of Object.entries(pkg.files)) {
  const p = join(out, "nominee", f);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(t));
}
writeFileSync(
  join(out, "nominee", "package.json"),
  JSON.stringify({ ...pkg, files: Object.keys(pkg.files) }, null, 2) + "\n",
);
for (const d of a
  .prepare("SELECT area,name,content FROM documents")
  .all() as any[]) {
  const p = join(out, "architect-documents", d.area, d.name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, d.content);
}
