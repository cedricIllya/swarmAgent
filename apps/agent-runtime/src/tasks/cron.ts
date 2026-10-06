import type { Run } from "@swarm/contracts";
import { browserHoldsMail, processEmail } from "./inbox";
import { foundTaskPrompt, taskServices, TICK_RETRY_PROMPT, tickPrompt } from "../llm/prompts";
import { classificationPending, ensureWorkGuides } from "../onboarding/service-guide";
import type { AgentRuntime } from "../runtime";
import { parseFoundTasks, selectNewTasks, surveySummary, taskRunTitle, type FoundTask } from "./found-tasks";
import { finishServiceThink } from "./service-work";
import { log, warn } from "../core/log";

export const CHECK_TITLE = "Плановая проверка сервисов";
const MAX_FOUND = 8;

/** Названия, уже принятые в этом проходе. Остаются до конца тика, даже если задача успела закрыться. */
const taken = new Set<string>();
const startedTitles: string[] = [];
const alreadyTitles: string[] = [];
let work: Promise<void> = Promise.resolve();

function resetFound(): void {
  taken.clear();
  startedTitles.length = 0;
  alreadyTitles.length = 0;
}

async function waitFoundWork(): Promise<void> {
  let seen = Promise.resolve();
  while (seen !== work) {
    seen = work;
    await seen;
  }
}

let running = false;

/**
 * Тик раз в 15 минут. Новая почта сюда не поллится — она приходит вебхуком.
 * Здесь: отложенные письма (если браузер освободился) и просмотр сервисов,
 * где есть назначенная работа. Найденная задача сразу идёт отдельным прогоном,
 * проверка в это время смотрит дальше. Оплата, ключи и прочие сервисы без входящих не открываются.
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

    resetFound();
    const run = await rt.createRun("cron", CHECK_TITLE, null);
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
      if (status !== "waiting_approval") {
        if (status === "done") {
          for (const task of parseFoundTasks(text)) await acceptFoundTask(rt, run.id, task);
        }
        await rt.finishRun(run, status, surveySummary(text, startedTitles, alreadyTitles));
      }
    } catch (e) {
      if (await rt.isCanceled(run.id)) return { deferred, checkedServices: true };
      await rt.step(run.id, "error", String(e));
      await rt.finishRun(run, "failed", String(e));
    } finally {
      await waitFoundWork();
    }
    return { deferred, checkedServices: true };
  } finally {
    running = false;
  }
}

export type AcceptedTask =
  | { ok: true; started: true; runId: string; title: string }
  | { ok: true; started: false; title: string }
  | { ok: false; error: string };

/**
 * Плановая проверка нашла задачу. Прогон создаётся сразу, работа начинается
 * не дожидаясь конца проверки. Повтор с тем же названием не стартует второй раз.
 */
export async function acceptFoundTask(
  rt: AgentRuntime,
  sourceRunId: string,
  input: { service: string; title: string; detail?: string },
): Promise<AcceptedTask> {
  const source = await rt.store.getRun(sourceRunId);
  if (!source) return { ok: false, error: "run not found" };
  if (source.title !== CHECK_TITLE || (source.status !== "running" && source.status !== "queued")) {
    return { ok: false, error: "задача ставится только из плановой проверки" };
  }
  const task: FoundTask = {
    service: input.service.trim().slice(0, 80),
    title: input.title.replace(/\s+/g, " ").trim().slice(0, 120),
    detail: (input.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 2000) || input.title.trim(),
  };
  if (!task.service || !task.title) return { ok: false, error: "нужны service и title" };
  const title = taskRunTitle(task);
  const key = title.toLowerCase();
  if (taken.has(key) || startedTitles.length >= MAX_FOUND) {
    return { ok: true, started: false, title };
  }
  const open = (await rt.store.listRuns(200)).filter(
    (r) => r.status === "queued" || r.status === "running" || r.status === "waiting_approval",
  );
  const { fresh } = selectNewTasks([task], open.map((r) => r.title));
  taken.add(key);
  if (!fresh.length) {
    alreadyTitles.push(title);
    return { ok: true, started: false, title };
  }
  const run = await rt.createRun("cron", title, null, "queued");
  await rt.step(run.id, "note", `${task.service}: ${task.detail}`);
  await rt.step(source.id, "note", `В работе: ${run.title}`);
  startedTitles.push(run.title);
  log("cron", "задача начата", { id: run.id, title: run.title });
  // Цепочка стартует на ближайшем шаге цикла, не дожидаясь конца проверки.
  // Следующая найденная задача ждёт, пока предыдущая освободит браузер.
  work = work.then(() => runFoundTask(rt, run, task)).catch((e) => {
    warn("cron", "задача из проверки упала", { id: run.id, error: String(e) });
  });
  return { ok: true, started: true, runId: run.id, title: run.title };
}

/** Ход Hermes у отдельной задачи. Вызов не ждёт конца плановой проверки. */
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
