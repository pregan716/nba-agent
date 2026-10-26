import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { sha256 } from "./store.js";

const schema = z.strictObject({
  schemaVersion: z.literal(1),
  release: z.string().min(1),
  provenance: z.strictObject({
    repository: z.string().url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  accounts: z
    .array(
      z.strictObject({
        accountId: z.string().regex(/^\d+$/),
        handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
        name: z.string().min(1),
      }),
    )
    .min(1),
});

/** Identity labels only, not claims about coverage, reliability or post content. */
export class PostAuthors {
  readonly version: {
    source: string;
    release: string;
    manifest_sha256: string;
  };
  #handles = new Map<string, string>();
  constructor(bytes: Buffer) {
    const parsed = schema.parse(JSON.parse(bytes.toString()));
    for (const account of parsed.accounts) {
      if (this.#handles.has(account.accountId))
        throw Error("Duplicate post author account ID");
      this.#handles.set(account.accountId, account.handle);
    }
    this.version = Object.freeze({
      source: "postAuthors",
      release: parsed.release,
      manifest_sha256: sha256(bytes),
    });
  }
  handle(accountId: string): string | undefined {
    return this.#handles.get(accountId);
  }
}
export async function loadPostAuthors(root: string): Promise<PostAuthors> {
  return new PostAuthors(
    await readFile(resolve(root, "config/post-authors.json")),
  );
}
