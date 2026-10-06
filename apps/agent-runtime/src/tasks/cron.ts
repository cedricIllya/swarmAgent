import type { Run } from "@swarm/contracts";
import { browserHoldsMail, processEmail } from "./inbox";
import { foundTaskPrompt, taskServices, TICK_RETRY_PROMPT, tickPrompt } from "../llm/prompts";
import { classificationPending, ensureWorkGuides } from "../onboarding/service-guide";
import type { AgentRuntime } from "../runtime";
import { parseFoundTasks, selectNewTasks, surveySummary, taskRunTitle, type FoundTask } from "./found-tasks";
import { finishServiceThink } from "./service-work";
import { log, warn } from "../core/log";

let running = false;

/**
 * Тик раз в 15 минут. Новая почта сюда не поллится — она приходит вебхуком.
 * Здесь: отложенные письма (если браузер освободился) и просмотр сервисов,
 * где есть назначенная работа. Найденные задачи ставятся в очередь и выполняются
 * отдельными прогонами. Оплата, ключи и прочие сервисы без входящих не открываются.
 */
export async function tick(rt: AgentRuntime): Promise<{ deferred: number; checkedServices: boolean }> {
  if (running) return { deferred: 0, checkedServices: false };
  running = true;
  try {
    let deferred = 0;
    if (!browserHoldsMail(rt)) {
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
    const connected =
      services?.recipes.filter((r) => services.credentials.some((c) => c.slug === r.slug)) ?? [];
    if (!connected.length) {
      log("cron", "тик: подключённых сервисов нет", { deferred });
      return { deferred, checkedServices: false };
    }
    const pending = connected.some(classificationPending);
    if (!pending && !taskServices(services!).length) {
      log("cron", "тик: сервисов с задачами нет", { deferred });
      return { deferred, checkedServices: false };
    }

    const run = await rt.createRun("cron", "Плановая проверка сервисов", null);
    try {
      await ensureWorkGuides(rt, run);
      if (await rt.isCanceled(run.id)) return { deferred, checkedServices: true };
      const fresh = (await rt.store.readServices()) ?? services!;
      if (!taskServices(fresh).length) {
        await rt.finishRun(run, "done", "пусто");
        return { deferred, checkedServices: false };
      }
      const turn = await rt.think(run, tickPrompt(fresh), "hermes.tick");
      const { text, status } = await finishServiceThink(rt, run, turn, { retryPrompt: TICK_RETRY_PROMPT });
      if (await rt.isCanceled(run.id)) return { deferred, checkedServices: true };
      if (status === "waiting_approval") return { deferred, checkedServices: true };
      const queued = status === "done" ? await queueFoundTasks(rt, text) : { runs: [], already: [] };
      if (queued.runs.length) {
        await rt.step(run.id, "note", `В очередь: ${queued.runs.map((item) => item.run.title).join("; ")}`);
      }
      await rt.finishRun(run, status, surveySummary(text, queued.runs.map((item) => item.run.title), queued.already));
      for (const item of queued.runs) {
        try {
          await runFoundTask(rt, item.run, item.task);
        } catch (e) {
          warn("cron", "задача из проверки упала", { id: item.run.id, error: String(e) });
        }
      }
    } catch (e) {
      if (await rt.isCanceled(run.id)) return { deferred, checkedServices: true };
      await rt.step(run.id, "error", String(e));
      await rt.finishRun(run, "failed", String(e));
    }
    return { deferred, checkedServices: true };
  } finally {
    running = false;
  }
}

/** Ставит найденное отдельными задачами. Уже идущие с тем же названием пропускает. */
async function queueFoundTasks(
  rt: AgentRuntime,
  text: string,
): Promise<{ runs: { run: Run; task: FoundTask }[]; already: string[] }> {
  const found = parseFoundTasks(text);
  if (!found.length) return { runs: [], already: [] };
  const open = (await rt.store.listRuns(200)).filter(
    (r) => r.status === "queued" || r.status === "running" || r.status === "waiting_approval",
  );
  const { fresh, already } = selectNewTasks(
    found,
    open.map((r) => r.title),
  );
  const runs: { run: Run; task: FoundTask }[] = [];
  for (const task of fresh) {
    const run = await rt.createRun("cron", taskRunTitle(task), null, "queued");
    await rt.step(run.id, "note", `${task.service}: ${task.detail}`);
    runs.push({ run, task });
  }
  if (runs.length) log("cron", "задачи в очереди", { count: runs.length });
  return { runs, already };
}

/** Ход Hermes уже у отдельной задачи, после того как проверка закрыта. */
async function runFoundTask(rt: AgentRuntime, run: Run, task: FoundTask): Promise<void> {
  if (await rt.isCanceled(run.id)) return;
  const current = (await rt.store.getRun(run.id)) ?? run;
  if (current.status !== "queued" && current.status !== "running") return;
  current.status = "running";
  await rt.store.saveRun(current);
  log("run", "начата", { id: current.id, trigger: current.trigger, title: current.title });
  try {
    const turn = await rt.think(current, foundTaskPrompt(task), "hermes.task");
    const { text, status } = await finishServiceThink(rt, current, turn, { allowIdle: false });
    if (await rt.isCanceled(current.id)) return;
    if (status !== "waiting_approval") await rt.finishRun(current, status, text);
  } catch (e) {
    if (await rt.isCanceled(current.id)) return;
    warn("cron", "задача из проверки упала", { id: current.id, error: String(e) });
    await rt.step(current.id, "error", String(e));
    await rt.finishRun(current, "failed", String(e));
  }
}

export function startTicker(rt: AgentRuntime, minutes: number): NodeJS.Timeout {
  const ms = Math.max(1, minutes) * 60 * 1000;
  return setInterval(() => {
    tick(rt).catch((e) => warn("cron", "тик упал", { error: String(e) }));
  }, ms);
}
