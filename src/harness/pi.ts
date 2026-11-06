import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionError } from "../env/contract.js";
import type { Harness } from "../runner/runner.js";
import type { AnalystOptions } from "./loop.js";
import { DEFAULT_LOOP } from "./version.js";

/** Fresh, credential-free process per phase. Only contract handles cross IPC. */
export function piHarness(options: AnalystOptions): Harness {
  return async ({ session, model, memoryInstructions }) => {
    const root = await mkdtemp(join(tmpdir(), "nba-pi-"));
    const source = import.meta.url.endsWith(".ts");
    const worker = fork(
      new URL(source ? "./pi-worker.ts" : "./pi-worker.js", import.meta.url),
      [],
      {
        cwd: root,
        execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
        // Deliberately do not spread/read process.env. Even Pi's availability
        // checks cannot discover real provider keys or the host agent directory.
        env: {
          HOME: root,
          TMPDIR: root,
          PI_CODING_AGENT_DIR: root,
          PI_OFFLINE: "1",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let failure: Error | undefined;
    let finalHistoryRecorded = false;
    let stderr = "";
    worker.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    const loop = { ...DEFAULT_LOOP, ...options.loop };
    const timer = setTimeout(
      () => {
        failure = Error("Pi harness timeout safeguard");
        worker.kill();
      },
      Math.min(2_147_483_647, loop.timeoutMs * (loop.maxTurns + 1)),
    );
    let completed!: Promise<void>;
    session.onClose?.(async () => {
      // Disconnection does not mean buffered history has been delivered.
      if (worker.connected) worker.send({ type: "abort" });
      const killTimer = setTimeout(() => worker.kill(), 5000);
      try {
        await completed.catch(() => {});
      } finally {
        clearTimeout(killTimer);
      }
    });
    try {
      completed = new Promise<void>((resolve, reject) => {
        worker.on("error", (error) => {
          failure = error;
          worker.kill();
        });
        worker.on("message", async (message: any) => {
          if (message.type === "call") {
            try {
              const value = await session.call(message.name, message.args);
              if (worker.connected)
                worker.send({ type: "result", id: message.id, value });
            } catch (error: any) {
              if (worker.connected)
                worker.send({
                  type: "result",
                  id: message.id,
                  error: {
                    message: error.message,
                    sessionError: error instanceof SessionError,
                    code: error.code,
                    limit: error.limit,
                  },
                });
            }
          } else if (message.type === "history") {
            try {
              session.recordHistory?.(message.history);
              if (message.final) {
                finalHistoryRecorded = true;
                worker.send({ type: "history_recorded" });
              }
            } catch (error) {
              failure = error as Error;
              worker.kill();
            }
          } else if (message.type === "failure")
            failure = Error(message.message);
        });
        // The final snapshot must be acknowledged before the worker exits.
        // Also wait for stdio closure before allowing runner cleanup.
        worker.once("close", (code) => {
          if (failure) reject(failure);
          else if (code !== 0)
            reject(Error(`Pi worker exited ${code}: ${stderr}`));
          else if (!finalHistoryRecorded)
            reject(Error("Pi exited without recording its final history"));
          else resolve();
        });
        worker.send({
          type: "start",
          options: {
            model: options.model,
            process: options.process,
            promptSet: options.promptSet,
            loop: options.loop,
          },
          model,
          memoryInstructions,
          root,
        });
      });
      await completed;
    } finally {
      clearTimeout(timer);
      worker.kill();
      await rm(root, { recursive: true, force: true });
    }
  };
}
