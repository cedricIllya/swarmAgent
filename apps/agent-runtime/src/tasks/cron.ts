import type { Run } from "@swarm/contracts";
import { browserHoldsMail, processEmail } from "./inbox";
import { foundTaskPrompt, taskServices, TICK_RETRY_PROMPT, tickPrompt } from "../llm/prompts";
import { surveySavedCalls } from "./replay";
import { splitTaskSurvey, surveySavedPages } from "./watch-page";
import { classificationPending, ensureWorkGuides } from "../onboarding/service-guide";
import type { AgentRuntime } from "../runtime";
import { parseFoundTasks, selectNewTasks, surveySummary, taskRunTitle, type FoundTask } from "./found-tasks";
import { bindWork, dropWork, holdWork } from "./work-claim";
import { finishServiceThink } from "./service-work";
import { listenMessengers } from "../channels/listen";
import { log, warn } from "../core/log";
import { beginWork } from "../core/spent";
import { recordSurvey } from "./tick-quiet";

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

export interface TickResult {
  deferred: number;
  checkedServices: boolean;
  /** `leave` — обхода не было. `clear` — будить как обычно. `until` — несколько пустых подряд. */
  quiet: "leave" | "clear" | "until";
  quietUntil: string | null;
}

async function answered(
  rt: AgentRuntime,
  base: { deferred: number; checkedServices: boolean },
  outcome: "leave" | "empty" | "work",
): Promise<TickResult> {
  if (outcome === "leave") return { ...base, quiet: "leave", quietUntil: null };
  const quietUntil = await recordSurvey(rt, outcome === "empty" ? "empty" : "work");
  return { ...base, quiet: quietUntil ? "until" : "clear", quietUntil };
}

/** Пустой список и ни одной новой задачи. «Уже в работе» серию не копит: доска не пустая. */
function surveyWasEmpty(summary: string, started: number): boolean {
  return started === 0 && summary === "пусто";
}

/**
 * Тик раз в 15 минут. Новая почта сюда не поллится — она приходит вебхуком.
 * Мессенджер читается здесь запасным путём: событие Slack приходит сразу,
 * тик дочитывает то, что не дошло. Новое сообщение становится задачей, как чат.
 * Дальше — отложенные письма (если браузер освободился) и просмотр сервисов для задач.
 * Браузерный сервис с сохранённой страницей и API/MCP с запомненным вызовом runtime читает сам.
 * Модель зовётся, только если список изменился или вызов ещё не запомнен.
 * Найденная задача сразу идёт отдельным прогоном, проверка в это время смотрит дальше.
 * Пустой список сервис из обхода не убирает. Оплата, ключи и прочие сервисы не для задач не открываются.
 */
export async function tick(rt: AgentRuntime): Promise<TickResult> {
  if (running) return answered(rt, { deferred: 0, checkedServices: false }, "leave");
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

    try {
      await listenMessengers(rt);
    } catch (e) {
      warn("cron", "мессенджеры не прочитаны", { error: String(e) });
    }

    const services = await rt.store.readServices();
    const connected =
      services?.recipes.filter((r) => services.credentials.some((c) => c.slug === r.slug)) ?? [];
    if (!connected.length) {
      log("cron", "тик: подключённых сервисов нет", { deferred });
      return answered(rt, { deferred, checkedServices: false }, "leave");
    }
    const pending = connected.some(classificationPending);
    if (!pending && !taskServices(services!).length) {
      log("cron", "тик: сервисов с задачами нет", { deferred });
      return answered(rt, { deferred, checkedServices: false }, "leave");
    }

    resetFound();
    const run = await rt.createRun("cron", CHECK_TITLE, null);
    try {
      await ensureWorkGuides(rt, run);
      if (await rt.isCanceled(run.id)) return answered(rt, { deferred, checkedServices: true }, "leave");
      const fresh = (await rt.store.readServices()) ?? services!;
      if (!taskServices(fresh).length) {
        await rt.finishRun(run, "done", "пусто");
        return answered(rt, { deferred, checkedServices: false }, "empty");
      }
      const surveyed = await surveySavedPages(rt, run);
      const called = await surveySavedCalls(rt, run);
      if (await rt.isCanceled(run.id)) return answered(rt, { deferred, checkedServices: true }, "leave");
      for (const task of [...surveyed.tasks, ...called.tasks]) await acceptFoundTask(rt, run.id, task);
      if (!splitTaskSurvey(fresh).rest.length) {
        const status = surveyed.failed + called.failed > 0 && startedTitles.length === 0 ? "failed" : "done";
        const summary = status === "failed" ? "страница задач не прочитана" : surveySummary("пусто", startedTitles, alreadyTitles);
        await rt.finishRun(run, status, summary);
        return answered(rt, { deferred, checkedServices: true }, surveyWasEmpty(summary, startedTitles.length) ? "empty" : "work");
      }
      const turn = await rt.think(run, tickPrompt(fresh), "hermes.tick");
      const { text, status } = await finishServiceThink(rt, run, turn, { retryPrompt: TICK_RETRY_PROMPT });
      if (await rt.isCanceled(run.id)) return answered(rt, { deferred, checkedServices: true }, "leave");
      if (status !== "waiting_approval") {
        if (status === "done") {
          for (const task of parseFoundTasks(text)) await acceptFoundTask(rt, run.id, task);
        }
        const summary = surveySummary(text, startedTitles, alreadyTitles);
        await rt.finishRun(run, status, summary);
        return answered(rt, { deferred, checkedServices: true }, surveyWasEmpty(summary, startedTitles.length) ? "empty" : "work");
      }
    } catch (e) {
      if (await rt.isCanceled(run.id)) return answered(rt, { deferred, checkedServices: true }, "leave");
      await rt.step(run.id, "error", String(e));
      await rt.finishRun(run, "failed", String(e));
      return answered(rt, { deferred, checkedServices: true }, "work");
    } finally {
      await waitFoundWork();
    }
    return answered(rt, { deferred, checkedServices: true }, "leave");
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
 * не дожидаясь конца проверки. Та же метка из письма или прошлой проверки
 * второй прогон не открывает, пока первый не закрыт.
 */
export async function acceptFoundTask(
  rt: AgentRuntime,
  sourceRunId: string,
  input: { service: string; title: string; detail?: string; key?: string },
): Promise<AcceptedTask> {
  const source = await rt.store.getRun(sourceRunId);
  if (!source) return { ok: false, error: "run not found" };
  if (source.title !== CHECK_TITLE || (source.status !== "running" && source.status !== "queued")) {
    return { ok: false, error: "задача ставится только из плановой проверки" };
  }
  const mark = input.key?.replace(/\s+/g, " ").trim().slice(0, 200);
  const task: FoundTask = {
    service: input.service.trim().slice(0, 80),
    title: input.title.replace(/\s+/g, " ").trim().slice(0, 120),
    detail: (input.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 2000) || input.title.trim(),
    ...(mark ? { key: mark } : {}),
  };
  if (!task.service || !task.title) return { ok: false, error: "нужны service и title" };
  const title = taskRunTitle(task);
  const takenKey = title.toLowerCase();
  if (taken.has(takenKey) || startedTitles.length >= MAX_FOUND) {
    return { ok: true, started: false, title };
  }
  taken.add(takenKey);
  const hold = await holdWork(rt, {
    service: task.service,
    title,
    texts: [task.service, task.title, task.detail, task.key ?? ""],
    ...(task.key ? { key: task.key } : {}),
    broad: false,
  });
  if (!hold.ok) {
    alreadyTitles.push(title);
    log("cron", "задача уже в работе", { title, runId: hold.runId });
    if (hold.runId) {
      await rt
        .step(hold.runId, "note", `Та же задача нашлась в проверке («${title}»), второй раз не начинаю`)
        .catch((e) => warn("cron", "не записал пропуск повтора", { error: String(e) }));
    }
    return { ok: true, started: false, title };
  }
  const open = (await rt.store.listRuns(200)).filter(
    (r) => r.status === "queued" || r.status === "running" || r.status === "waiting_approval",
  );
  const { fresh } = selectNewTasks([task], open.map((r) => r.title));
  if (!fresh.length) {
    dropWork(rt, hold.id);
    alreadyTitles.push(title);
    return { ok: true, started: false, title };
  }
  let run: Run;
  try {
    run = await rt.createRun("cron", title, null, "queued");
  } catch (e) {
    dropWork(rt, hold.id);
    throw e;
  }
  bindWork(rt, hold.id, run.id, run.title);
  await rt.step(run.id, "note", `${task.service}: ${task.detail}`, {
    service: task.service,
    workMarks: hold.marks,
    broad: hold.broad,
  });
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
  beginWork(current);
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
