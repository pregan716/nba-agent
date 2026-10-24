import { z } from "zod";
import { RecordStore } from "../runner/record.js";
import { readBlob } from "../runner/blobs.js";
/** Human-reviewed claims are stored with the frozen evidence they cite. */
export const annotationSchema = z
  .object({
    category: z.enum(["stale beliefs", "useful transfer", "repeated errors"]),
    explanation: z.string().min(1),
    workspace: z
      .array(
        z
          .object({
            sessionSeq: z.number().int().positive(),
            path: z.string().min(1),
            side: z.enum(["before", "after"]),
            quote: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    questions: z
      .array(z.object({ gameId: z.string(), questionId: z.string() }).strict())
      .min(1),
  })
  .strict();
export function annotate(root: string, value: unknown) {
  const annotation = annotationSchema.parse(value),
    record = new RecordStore(root);
  try {
    if (
      record.events("manifest")[0].data.config.profile.memory.horizon ===
      "stateless"
    )
      throw Error("Learning annotations require persistent memory");
    for (const ref of annotation.workspace) {
      const event = record
        .events("session_end")
        .find((e) => e.seq === ref.sessionSeq);
      const hash = event?.data[ref.side]?.files[ref.path];
      if (!readBlob(root, hash).toString("utf8").includes(ref.quote))
        throw Error("Workspace quote does not match recorded evidence");
    }
    for (const ref of annotation.questions) {
      if (
        !record
          .events("questions", ref.gameId)[0]
          ?.data.questions.some((q: any) => q.question_id === ref.questionId)
      )
        throw Error("Unknown question reference");
      if (!record.events("resolution_input", ref.gameId).length)
        throw Error("Question outcome evidence not captured");
    }
    record.append("learning_annotation", "run", annotation);
  } finally {
    record.close();
  }
}
