import { Type } from "typebox";
import { z } from "zod";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { developmentService } from "../evaluation/service/index.js";
import {
  ReviewerFailure,
  ReviewRejection,
} from "../evaluation/review/index.js";
import { readPackage } from "../game-loop/package.js";
import type { Iteration } from "./iteration.js";

type Service = ReturnType<typeof developmentService>;
const nonempty = z.string().trim().min(1),
  empty = z.strictObject({});
const area = z.enum(["notes", "draft"]);
const filename = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*\.py$/);
const page = z.number().int().nonnegative().optional();
const proposal = { hypothesis: nonempty, expectedEffect: nonempty };
const submission = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("full"), ...proposal }),
  z.strictObject({
    kind: z.literal("test"),
    ...proposal,
    games: z
      .array(z.strictObject({ teamId: nonempty, gameId: nonempty }))
      .min(1)
      .max(5),
  }),
  z.strictObject({
    kind: z.literal("check"),
    ...proposal,
    runId: z.uuid(),
    window: z.enum(["opening", "late"]),
  }),
  z.strictObject({ kind: z.literal("repeat"), ...proposal, runId: z.uuid() }),
  z.strictObject({ kind: z.literal("nominate"), ...proposal, runId: z.uuid() }),
]);
function slice(text: string, offset = 0) {
  const content = text.slice(offset, offset + 16000);
  return {
    content,
    next:
      offset + content.length < text.length ? offset + content.length : null,
  };
}
export const submissionKinds = [
  "full",
  "test",
  "repeat",
  "check",
  "nominate",
] as const;
export type SubmissionKind = (typeof submissionKinds)[number];
/** `only` is an operator restriction on what this iteration may submit (the
 * pilot's first iteration is a test run). A refused kind leaves the iteration
 * open. */
export function architectTools(
  i: Iteration,
  s: Service,
  execute: (code: string) => Promise<unknown>,
  only?: readonly SubmissionKind[],
) {
  const db = i.db;
  function tool<S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    run: (args: z.infer<S>) => unknown,
  ): AgentTool {
    return {
      name,
      label: name,
      description,
      parameters: Type.Unsafe(z.toJSONSchema(schema)),
      async execute(_id, raw) {
        let value;
        try {
          if (i.status !== "running" || i.budget().sessionUsd <= 0)
            throw Error("Iteration ended");
          value = { result: await run(schema.parse(raw)) };
        } catch (e) {
          value = { error: e instanceof Error ? e.message : "Tool failed" };
        }
        const reply = { ...value, budget: i.budget() };
        i.record("tool_result", { name, ...reply });
        return {
          content: [{ type: "text", text: JSON.stringify(reply) }],
          details: undefined,
        };
      },
    };
  }
  function draft() {
    const rows = db
      .prepare("SELECT name,content FROM documents WHERE area='draft'")
      .all();
    const manifest = rows.find((r) => r.name === "package.json");
    if (!manifest) throw Error("Write package.json to the draft first");
    const metadata = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(String(manifest.content)));
    if ("files" in metadata)
      throw Error("Write Python files as separate draft documents");
    return readPackage({
      ...metadata,
      files: Object.fromEntries(
        rows.filter((r) => r !== manifest).map((r) => [r.name, r.content]),
      ),
    });
  }
  return [
    tool(
      "budget",
      "Remaining evaluation dollars, full evaluations, iteration and total architect dollars.",
      empty,
      () => ({ ...s.budget(), ...i.budget() }),
    ),
    tool(
      "data_python",
      "Run Python in the isolated architect data view. Read SQLite at /data/session.sqlite.",
      z.strictObject({ code: nonempty }),
      async ({ code }) => {
        try {
          return await execute(code);
        } catch {
          throw Error("Architect data sandbox unavailable");
        }
      },
    ),
    tool(
      "document_list",
      "List notes or draft files.",
      z.strictObject({ area }),
      (a) =>
        db
          .prepare("SELECT name FROM documents WHERE area=? ORDER BY name")
          .all(a.area),
    ),
    tool(
      "document_read",
      "Read a note or draft file, in character-offset pages.",
      z.strictObject({ area, name: nonempty, offset: page }),
      (a) => {
        const row = db
          .prepare("SELECT content FROM documents WHERE area=? AND name=?")
          .get(a.area, a.name);
        if (!row) throw Error("Unknown document");
        return slice(String(row.content), a.offset);
      },
    ),
    tool(
      "document_write",
      "Create or replace a note or draft file. Draft package.json holds version, entry, agents, artifacts, training and hypothesis; write each .py file separately.",
      z.strictObject({ area, name: nonempty, content: z.string() }),
      (a) => {
        if (a.area === "draft" && a.name !== "package.json")
          filename.parse(a.name);
        db.prepare(
          "INSERT INTO documents VALUES(?,?,?) ON CONFLICT(area,name) DO UPDATE SET content=excluded.content",
        ).run(a.area, a.name, a.content);
        return a.name;
      },
    ),
    tool(
      "document_edit",
      "Replace one exact passage in an existing note or draft file.",
      z.strictObject({
        area,
        name: nonempty,
        before: z.string().min(1),
        after: z.string(),
      }),
      (a) => {
        const row = db
          .prepare("SELECT content FROM documents WHERE area=? AND name=?")
          .get(a.area, a.name);
        if (!row) throw Error("Unknown document");
        const text = String(row.content),
          at = text.indexOf(a.before);
        if (at < 0 || text.lastIndexOf(a.before) !== at)
          throw Error("Passage must match exactly once");
        db.prepare(
          "UPDATE documents SET content=? WHERE area=? AND name=?",
        ).run(
          text.slice(0, at) + a.after + text.slice(at + a.before.length),
          a.area,
          a.name,
        );
        return a.name;
      },
    ),
    tool(
      "document_delete",
      "Remove a note or obsolete draft file.",
      z.strictObject({ area, name: nonempty }),
      (a) =>
        Number(
          db
            .prepare("DELETE FROM documents WHERE area=? AND name=?")
            .run(a.area, a.name).changes,
        ),
    ),
    tool(
      "validate_package",
      "Validate the draft schema and file references without submitting.",
      empty,
      () => ({ hash: draft().hash }),
    ),
    tool("hypotheses", "List hypotheses including closed entries.", empty, () =>
      db.prepare("SELECT * FROM hypotheses ORDER BY rowid").all(),
    ),
    tool(
      "hypothesis_write",
      "Add, update or close a named hypothesis.",
      z.strictObject({
        action: z.enum(["add", "update", "close"]),
        name: nonempty,
        description: nonempty.optional(),
      }),
      (a) => {
        if (a.action === "add") {
          if (!a.description) throw Error("Description required");
          if (
            !db
              .prepare("INSERT OR IGNORE INTO hypotheses VALUES(?,?,0)")
              .run(a.name, a.description).changes
          )
            throw Error("Hypothesis already exists");
        } else {
          if (a.action === "update" && !a.description)
            throw Error("Description required");
          if (
            !db
              .prepare(
                "UPDATE hypotheses SET description=COALESCE(?,description),closed=? WHERE name=? AND closed=0",
              )
              .run(a.description ?? null, Number(a.action === "close"), a.name)
              .changes
          )
            throw Error("Unknown open hypothesis");
        }
        return a.name;
      },
    ),
    tool(
      "iterations",
      "List iteration status, spend and recorded submission decisions.",
      empty,
      () => ({
        iterations: db
          .prepare(
            "SELECT id,started,status,spent*1e-9 AS spendUsd,held*1e-9 AS unresolvedUsd FROM iterations ORDER BY rowid",
          )
          .all(),
        submissions: db
          .prepare(
            "SELECT iteration,kind,data FROM events WHERE kind IN ('proposal','review','decision') ORDER BY seq",
          )
          .all()
          .map((r) => ({ ...r, data: JSON.parse(String(r.data)) })),
        runs: s.list(),
      }),
    ),
    tool(
      "archive_read",
      "Read a completed development run's configuration, agent calls, sandbox steps, forecasts or scores as paginated JSON.",
      z.strictObject({
        runId: z.uuid(),
        section: z.enum([
          "configuration",
          "calls",
          "sandboxSteps",
          "forecasts",
          "scores",
          "summary",
        ]),
        offset: page,
      }),
      (a) =>
        slice(
          JSON.stringify(
            a.section === "summary"
              ? s.summary(a.runId)
              : s.archive(a.runId)[a.section],
          ),
          a.offset,
        ),
    ),
    tool(
      "compare",
      "Compare two completed development evaluations.",
      z.strictObject({ left: z.uuid(), right: z.uuid() }),
      (a) => s.compare(a.left, a.right),
    ),
    tool(
      "submit",
      "End this iteration with a development evaluation or a nomination for the operator. Name an open hypothesis and its expected effect.",
      z.strictObject({
        kind: z.enum(submissionKinds),
        ...proposal,
        games: z
          .array(z.strictObject({ teamId: nonempty, gameId: nonempty }))
          .optional(),
        runId: z.uuid().optional(),
        window: z.enum(["opening", "late"]).optional(),
      }),
      async (raw) => {
        const a = submission.parse(raw);
        if (only && !only.includes(a.kind))
          throw Error("This iteration accepts only: " + only.join(", "));
        const hypothesis = db
          .prepare(
            "SELECT description FROM hypotheses WHERE name=? AND closed=0",
          )
          .get(a.hypothesis);
        if (!hypothesis) throw Error("Name an open hypothesis");
        const { hypothesis: name, expectedEffect, ...request } = a;
        const current = "runId" in request ? s.archive(request.runId) : draft();
        i.record("proposal", {
          ...request,
          hypothesis: name,
          expectedEffect,
          description: hypothesis.description,
          hash: current.hash,
        });
        const pkg = "pkg" in current ? current.pkg : current.configuration;
        i.record("configuration", pkg);
        let runId;
        try {
          if (a.kind === "nominate") {
            await s.nominate(a.runId, (r) => i.record("review", r));
            runId = a.runId;
          } else {
            const req =
              "runId" in request ? request : { ...request, package: pkg };
            const run = await s.evaluate(req, (r) => i.record("review", r));
            runId = run.id;
          }
        } catch (e) {
          const message =
            e instanceof ReviewRejection || e instanceof ReviewerFailure
              ? e.message
              : e instanceof Error &&
                  /^(Full evaluation cap exceeded|Evaluation dollar pool exceeded|Development closed after nomination|Unknown or duplicate development team-game|Nominate a full evaluation|Configuration ineligible for nomination)$/.test(
                    e.message,
                  )
                ? e.message
                : "Development request failed";
          if (e instanceof ReviewRejection) i.status = "rejected";
          i.record("decision", { kind: a.kind, error: message });
          throw Error(message);
        }
        i.status = a.kind;
        i.record("decision", { kind: a.kind, runId });
        return { runId };
      },
    ),
  ];
}
