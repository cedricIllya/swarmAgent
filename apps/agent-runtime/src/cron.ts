import { processEmail } from "./inbox";
import { tickPrompt } from "./prompts";
import type { AgentRuntime } from "./runtime";
import { finishServiceThink } from "./service-work";
import { log, warn } from "./log";

let running = false;

/**
 * Тик раз в 15 минут. Новая почта сюда не поллится — она приходит вебхуком.
 * Здесь: отложенные письма (если браузер освободился) и задачи в подключённых сервисах.
 */
export async function tick(rt: AgentRuntime): Promise<{ deferred: number; checkedServices: boolean }> {
  if (running) return { deferred: 0, checkedServices: false };
  running = true;
  try {
    let deferred = 0;
    if (!rt.busyInBrowser) {
      const emails = await rt.store.takeDeferredEmails();
      deferred = emails.length;
      for (const e of emails) {
        try {
          await processEmail(rt, e);
        } catch (err) {
          warn("cron", "отложенное письмо упало", { error: String(err) });
        }
      }
    }

    const services = await rt.store.readServices();
    const hasConnected = services?.recipes.some((r) => services.credentials.some((c) => c.slug === r.slug)) ?? false;
    if (!hasConnected) {
      log("cron", "тик: подключённых сервисов нет", { deferred });
      return { deferred, checkedServices: false };
    }

    const run = await rt.createRun("cron", "Плановая проверка сервисов", null);
    try {
      const turn = await rt.think(run, tickPrompt(services!), "hermes.tick");
      const { text, status } = await finishServiceThink(rt, run, turn);
      if (status !== "waiting_approval") await rt.finishRun(run, status, text);
    } catch (e) {
      await rt.step(run.id, "error", String(e));
      await rt.finishRun(run, "failed", String(e));
    }
    return { deferred, checkedServices: true };
  } finally {
    running = false;
  }
}

export function startTicker(rt: AgentRuntime, minutes: number): NodeJS.Timeout {
  const ms = Math.max(1, minutes) * 60 * 1000;
  return setInterval(() => {
    tick(rt).catch((e) => warn("cron", "тик упал", { error: String(e) }));
  }, ms);
}
