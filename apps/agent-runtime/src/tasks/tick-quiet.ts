import { readFile, writeFile } from "node:fs/promises";
import type { AgentRuntime } from "../runtime";

/** Сколько пустых обходов подряд, после которых проверку не будим час. */
export const QUIET_AFTER_EMPTY = 2;
export const QUIET_MS = 60 * 60 * 1000;

export interface QuietState {
  streak: number;
}

/**
 * Пустой обход увеличивает серию. Со второго подряд проверка молчит час.
 * Найденная или уже идущая работа серию сбрасывает.
 */
export function nextQuiet(
  state: QuietState,
  outcome: "empty" | "work",
  now: number,
): { state: QuietState; quietUntil: string | null } {
  if (outcome === "work") return { state: { streak: 0 }, quietUntil: null };
  const streak = state.streak + 1;
  const quietUntil = streak >= QUIET_AFTER_EMPTY ? new Date(now + QUIET_MS).toISOString() : null;
  return { state: { streak }, quietUntil };
}

function quietFile(rt: AgentRuntime): string | null {
  const store = rt.store as { dir?: (...parts: string[]) => string };
  if (typeof store.dir !== "function") return null;
  try {
    return store.dir("tick-quiet.json");
  } catch {
    return null;
  }
}

async function readState(file: string): Promise<QuietState> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { streak?: unknown };
    const streak = typeof raw.streak === "number" && raw.streak > 0 ? Math.floor(raw.streak) : 0;
    return { streak };
  } catch {
    return { streak: 0 };
  }
}

/** Запомнить исход обхода. `null` — будить как обычно. */
export async function recordSurvey(rt: AgentRuntime, outcome: "empty" | "work", now = Date.now()): Promise<string | null> {
  const file = quietFile(rt);
  const current = file ? await readState(file) : { streak: 0 };
  const next = nextQuiet(current, outcome, now);
  if (file) {
    await writeFile(file, JSON.stringify(next.state)).catch(() => undefined);
  }
  return next.quietUntil;
}

/** Письмо, чат или мессенджер: следующая проверка снова через обычный интервал. */
export async function resetSurveyQuiet(rt: AgentRuntime): Promise<void> {
  const file = quietFile(rt);
  if (!file) return;
  await writeFile(file, JSON.stringify({ streak: 0 })).catch(() => undefined);
}
