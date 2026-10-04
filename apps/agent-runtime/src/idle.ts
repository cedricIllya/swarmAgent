import { tick } from "./cron";
import type { AgentRuntime } from "./runtime";
import { warn } from "./log";

const IDLE_MS = Number(process.env.IDLE_SUSPEND_MS ?? 120_000);

let lastActivity = Date.now();
let suspending = false;

/** Письмо, чат, браузер: после этого ждём IDLE_MS и только потом спим. */
export function noteActivity(): void {
  lastActivity = Date.now();
}

/**
 * Тик ничего не запустил. Спим сразу, но не затираем активность,
 * которая пришла пока тик шёл.
 */
export function markSleepy(activityBefore: number): void {
  if (lastActivity <= activityBefore) lastActivity = 0;
}

export async function machineIsIdle(rt: AgentRuntime): Promise<boolean> {
  if (rt.busyInBrowser) return false;
  if (rt.sessions.size > 0) return false;
  const runs = await rt.store.listRuns(50);
  return !runs.some((r) => r.status === "running" || r.status === "queued");
}

async function maybeSuspend(rt: AgentRuntime): Promise<void> {
  if (suspending) return;
  if (Date.now() - lastActivity < IDLE_MS) return;
  if (!(await machineIsIdle(rt))) return;
  if (await rt.store.hasDeferredEmails()) {
    await tick(rt);
    if (!(await machineIsIdle(rt))) return;
  }
  suspending = true;
  try {
    await rt.controlPlane.requestSuspend();
  } catch (e) {
    warn("idle", "не удалось уснуть", { error: String(e) });
  } finally {
    suspending = false;
  }
}

/** Локально и при IDLE_SUSPEND=off машина не засыпает. */
export function startIdleWatch(rt: AgentRuntime): void {
  if (process.env.IDLE_SUSPEND === "off") return;
  if (!rt.controlPlane.enabled) return;
  const period = 10_000;
  let lastCheck = Date.now();
  setInterval(() => {
    const now = Date.now();
    // Suspend сохраняет память: после resume lastActivity старая, и машина
    // уснула бы через 10 секунд, не дождавшись работы, ради которой её подняли.
    if (now - lastCheck > period * 3) noteActivity();
    lastCheck = now;
    maybeSuspend(rt).catch((e) => warn("idle", "проверка простоя упала", { error: String(e) }));
  }, period);
}
