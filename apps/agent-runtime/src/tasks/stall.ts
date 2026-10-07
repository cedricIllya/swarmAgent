import type { AgentRuntime } from "../runtime";

/** Нет шага и нет браузера этой задачи — прогон больше не держит машину включённой. */
export const STALL_MS = 10 * 60 * 1000;

const STALL_SUMMARY = "нет движения 10 минут";

function browserOpenFor(rt: AgentRuntime, runId: string): boolean {
  const sessions = rt.browser?.sessions;
  if (!sessions || typeof sessions.values !== "function") return false;
  for (const session of sessions.values()) {
    if (session.meta.runId === runId && session.meta.finishedAt == null) return true;
  }
  return false;
}

/**
 * `running` и `queued` не дают машине уснуть. Задача без шагов дольше STALL_MS
 * закрывается с ошибкой. Ожидание человека сюда не входит: оно сон не держит.
 */
export async function closeStalledRuns(rt: AgentRuntime, now = Date.now()): Promise<number> {
  const runs = await rt.store.listRuns(50);
  let closed = 0;
  for (const run of runs) {
    if (run.status !== "running" && run.status !== "queued") continue;
    if (browserOpenFor(rt, run.id)) continue;
    const steps = await rt.store.listSteps(run.id);
    const stamp = steps.length ? steps[steps.length - 1]?.at : run.startedAt;
    const last = Date.parse(stamp ?? "");
    if (!Number.isFinite(last) || now - last < STALL_MS) continue;
    rt.abortRun(run.id);
    await rt.step(run.id, "error", "Нет шагов 10 минут — задача остановлена, чтобы машина могла уснуть");
    await rt.finishRun(run, "failed", STALL_SUMMARY);
    closed += 1;
  }
  return closed;
}
