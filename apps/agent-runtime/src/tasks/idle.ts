import type { UsageTotals } from "@swarm/contracts";
import { tick } from "./cron";
import { closeAllStreams } from "../core/events";
import type { AgentRuntime } from "../runtime";
import { warn } from "../core/log";

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
  if (rt.browser.sessions.size > 0) return false;
  const runs = await rt.store.listRuns(50);
  return !runs.some((r) => r.status === "running" || r.status === "queued");
}

/** Без итогов усыпить всё равно надо: сломанный журнал не должен держать машину. */
async function usageTotals(rt: AgentRuntime): Promise<UsageTotals | undefined> {
  try {
    const { totalCostUsd, totalPromptTokens, totalCompletionTokens } = await rt.store.usageSummary();
    return { totalCostUsd, totalPromptTokens, totalCompletionTokens };
  } catch (e) {
    warn("idle", "не удалось снять итоги usage", { error: String(e) });
    return undefined;
  }
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
    closeAllStreams();
    await new Promise((r) => setTimeout(r, 40));
    await rt.controlPlane.requestSuspend(await usageTotals(rt));
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
