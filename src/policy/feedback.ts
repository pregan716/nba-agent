import type { PolicyTrace } from "./replay.js";
import { SessionError } from "../env/contract.js";
export interface FeedbackQuery {
  cursor?: number;
  window_id?: string;
  offset?: number;
}
const preview = (value: unknown) => {
  const text = JSON.stringify(value ?? null);
  return { text: text.slice(0, 800), truncated: text.length > 800 };
};
/** Full forensic trace stays on disk; no tool result can expand with game length. */
function readPage(trace: PolicyTrace, query: FeedbackQuery = {}) {
  const { cursor = 0, offset = 0, window_id } = query;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new SessionError("invalid_input", "Invalid feedback page");
  if (window_id !== undefined) {
    const window = trace.windows.find((w) => w.result.window.id === window_id);
    if (!window)
      throw new SessionError("not_found", "Feedback window unavailable");
    const text = JSON.stringify(window),
      content = text.slice(offset, offset + 4096);
    return {
      gameId: trace.gameId,
      windowId: window_id,
      content,
      offset,
      nextOffset:
        offset + content.length < text.length ? offset + content.length : null,
    };
  }
  const windows = trace.windows.slice(cursor, cursor + 2).map((w) => {
    const state = w.result.window.state;
    return {
      windowId: w.result.window.id,
      stateSummary: state
        ? {
            period: state.period,
            clockMs: state.clockMs,
            celticsHome: trace.celticsHome ?? null,
            homeScore: state.homeScore,
            awayScore: state.awayScore,
            margin: state.margin,
            celtics: state.celtics,
            eligibleBench: state.eligibleBench,
            players: [
              ...new Set([...state.celtics, ...state.eligibleBench]),
            ].map((playerId) => {
              const player = state.players?.find(
                (p) => p.playerId === playerId,
              );
              return {
                playerId,
                personalFouls: player?.personalFouls ?? null,
                minutes: player?.minutes ?? null,
                currentStintMinutes: player?.currentStintMinutes ?? null,
              };
            }),
          }
        : null,
      diagnostics: preview(w.assembly?.assembly?.diagnostics),
      questions: preview(w.assembly?.request?.questions),
      answers: preview(w.result.raw),
      validation: preview(w.result.validation),
      ...(w.result.validation?.swap ? { swap: w.result.validation.swap } : {}),
      actual: w.result.window.actual,
      scores: w.result.scores,
      ...(w.result.code
        ? {
            code: {
              source: w.result.code.source,
              defer: w.result.code.defer,
              invalidPrediction: w.result.code.invalidPrediction,
              shadowFailure: w.result.code.shadowFailure,
              packagePrediction: preview(w.result.code.package.raw),
              shadowAnswer: preview(w.result.code.jev.raw),
              packageScores: w.result.code.package.scores,
              shadowScores: w.result.code.jev.scores,
              regret: w.result.code.regret,
            },
          }
        : {}),
      failure: w.result.failure,
      exclusions: w.result.window.exclusions,
    };
  });
  return {
    gameId: trace.gameId,
    ...(cursor === 0 ? { summary: trace.summary } : {}),
    totalWindows: trace.windows.length,
    windows,
    nextCursor:
      cursor + windows.length < trace.windows.length
        ? cursor + windows.length
        : null,
  };
}
export function feedbackPage(
  trace: PolicyTrace,
  query?: FeedbackQuery & { window_id?: undefined },
): Exclude<ReturnType<typeof readPage>, { windowId: string }>;
export function feedbackPage(
  trace: PolicyTrace,
  query: FeedbackQuery & { window_id: string },
): Extract<ReturnType<typeof readPage>, { windowId: string }>;
export function feedbackPage(
  trace: PolicyTrace,
  query: FeedbackQuery,
): ReturnType<typeof readPage>;
export function feedbackPage(trace: PolicyTrace, query: FeedbackQuery = {}) {
  return readPage(trace, query);
}
export type FeedbackPage = ReturnType<typeof readPage>;
