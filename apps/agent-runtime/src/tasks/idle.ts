import type { UsageTotals } from "@swarm/contracts";
import { tick, tickBusy } from "./cron";
import { closeStalledRuns } from "./stall";
import { closeAllStreams } from "../core/events";
import type { AgentRuntime } from "../runtime";
import { warn } from "../core/log";

/** Пять минут без задач. `IDLE_SUSPEND_MS` по-прежнему перебивает паузу. */
export const IDLE_MS = Number(process.env.IDLE_SUSPEND_MS ?? 5 * 60 * 1000);

let lastActivity = Date.now();
let suspending = false;

/** Пришла задача или задача только что закончилась: пять минут тишины считаются заново. */
export function noteActivity(): void {
  lastActivity = Date.now();
}

export async function machineIsIdle(rt: AgentRuntime): Promise<boolean> {
  if (tickBusy()) return false;
  if (rt.busyInBrowser) return false;
  if (rt.browser.sessions.size > 0) return false;
  const runs = await rt.store.listRuns(50);
  return !runs.some((r) => r.status === "running" || r.status === "queued");
}

/**
 * Сон только когда задач нет уже пять минут.
 * Идущая или поставленная в очередь задача, браузер и незакрытый тик удерживают машину.
 * Ожидание одобрения само по себе не удерживает.
 */
export async function canSuspendNow(rt: AgentRuntime, now = Date.now()): Promise<boolean> {
  if (now - lastActivity < IDLE_MS) return false;
  return machineIsIdle(rt);
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
  await closeStalledRuns(rt);
  // Пока задача идёт, пять минут не тикают: окно начнётся, когда её не станет.
  if (!(await machineIsIdle(rt))) {
    noteActivity();
    return;
  }
  if (Date.now() - lastActivity < IDLE_MS) return;
  if (await rt.store.hasDeferredEmails()) {
    await tick(rt);
    if (!(await canSuspendNow(rt))) return;
  }
  suspending = true;
  try {
    const usage = await usageTotals(rt);
    // Пока снимали итоги, тик или чат уже могли создать задачу.
    if (!(await canSuspendNow(rt))) return;
    closeAllStreams();
    await new Promise((r) => setTimeout(r, 40));
    if (!(await canSuspendNow(rt))) return;
    await rt.controlPlane.requestSuspend(usage);
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
