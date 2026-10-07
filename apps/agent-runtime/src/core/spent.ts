import { parseUserQuestion, type Run } from "@swarm/contracts";

/** Начать новый отрезок. Уже идущий не сдвигается. Старой задаче засчитывается прежний отрезок. */
export function beginWork(run: Run, at = new Date().toISOString()): void {
  if (typeof run.activeMs !== "number") {
    const start = Date.parse(run.startedAt);
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
    run.activeMs = !Number.isNaN(start) && !Number.isNaN(end) && end >= start ? end - start : 0;
  }
  if (!run.activeSince) run.activeSince = at;
}

/** Закрыть текущий отрезок. Повторный вызов на паузе ничего не добавляет. */
export function pauseWork(run: Run, at = Date.now()): void {
  if (!run.activeSince) return;
  const since = Date.parse(run.activeSince);
  run.activeSince = null;
  if (Number.isNaN(since)) return;
  run.activeMs = (run.activeMs ?? 0) + Math.max(0, at - since);
}

/**
 * Задача остановилась или встала на паузу.
 * Старая запись без учёта считается от `startedAt` до этого момента.
 */
export function settleWork(run: Run, at = Date.now()): void {
  if (typeof run.activeMs !== "number" && !run.activeSince) run.activeSince = run.startedAt;
  pauseWork(run, at);
}

/** «4 мин», «1 ч 12 мин». Меньше секунды показывается как одна секунда. */
export function formatSpent(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec} с`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  const minutes = min % 60;
  if (hours < 24) return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days} д ${h} ч` : `${days} д`;
}

/** Дописать итог в ответ человеку. Вопрос с вариантами не трогает: иначе последний пункт раздуется. */
export function replyWithSpent(text: string, run: Pick<Run, "status" | "activeMs">): string {
  if (run.status !== "done" || typeof run.activeMs !== "number") return text;
  const body = text.trim();
  if (!body || parseUserQuestion(body)) return text;
  const line = `Заняло ${formatSpent(run.activeMs)}.`;
  if (body.split("\n").some((row) => row.trim() === line)) return text;
  return `${body}\n\n${line}`;
}
