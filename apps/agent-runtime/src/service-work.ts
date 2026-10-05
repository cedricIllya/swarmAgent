import type { Run, RunStep } from "@swarm/contracts";
import type { AgentRuntime, ThinkResult } from "./runtime";

/** Шаги, которые значат: агент реально трогал сервис (не только текст модели). */
const SERVICE_ACTION_KINDS = new Set(["tool", "mcp", "api", "browser"]);

/** Подсказка, если в журнале нет следов работы в сервисе. */
export const NO_SERVICE_ACTION_PROMPT = [
  "В журнале этой задачи нет вызовов сервиса (MCP, API, браузер).",
  "Нельзя писать, что готово.",
  "Сделай работу в сервисе сейчас: инструменты mcp_*, curl к API или /browser/*.",
  "После действия отметь шаг: POST /runs/<runId>/step с kind mcp|api|browser.",
  "Если выполнить нельзя — коротко напиши, что именно помешало, без слова «готово».",
].join(" ");

/** Добавляет runId в подсказку, если его ещё нет. */
export function ensureRunId(runId: string, prompt: string): string {
  if (prompt.includes(runId)) return prompt;
  return `runId этой задачи: ${runId}. Передавай его во все вызовы runtime.\n\n${prompt}`;
}

/** Ответ «делать нечего» — без вызовов сервиса допустим. */
export function isIdleServiceReply(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return false;
  if (t === "пусто") return true;
  if (/не\s+удал/.test(t) || /помешал/.test(t) || /не\s+смог/.test(t)) return true;
  return /(?:задач(?:и)?\s+нет|нет\s+задач|нечего\s+делать|задач\s+для\s+меня\s+нет)/i.test(t);
}

/** Были ли за ход шаги работы в сервисе (или запись доступа через /report). */
export function turnHasServiceAction(steps: RunStep[], since: string): boolean {
  return steps.some((s) => {
    if (s.at < since) return false;
    if (SERVICE_ACTION_KINDS.has(s.kind)) return true;
    return s.kind === "note" && /подключён сервис|найден способ входа/i.test(s.text);
  });
}

/**
 * Один или два хода Hermes для задачи в сервисе: при отсутствии следов работы
 * — повтор с жёсткой подсказкой; без инструментов Hermes — failed.
 */
export async function finishServiceThink(
  rt: AgentRuntime,
  run: Run,
  first: ThinkResult,
  opts?: { allowIdle?: boolean },
): Promise<{ text: string; status: "done" | "failed" | "waiting_approval" }> {
  const allowIdle = opts?.allowIdle !== false;
  const current = await rt.store.getRun(run.id);
  if (current?.status === "waiting_approval") return { text: first.text, status: "waiting_approval" };

  if (first.usedFallback) {
    await rt.step(run.id, "error", "Hermes недоступен: ответ без инструментов");
    const text = first.text.trim() || "Инструменты недоступны, работу в сервисе выполнить не удалось.";
    return { text, status: "failed" };
  }

  const steps = await rt.store.listSteps(run.id);
  if (turnHasServiceAction(steps, first.startedAt) || (allowIdle && isIdleServiceReply(first.text))) {
    return { text: first.text, status: "done" };
  }

  const retry = await rt.think(run, NO_SERVICE_ACTION_PROMPT, "hermes.retry");
  const after = await rt.store.getRun(run.id);
  if (after?.status === "waiting_approval") return { text: retry.text, status: "waiting_approval" };

  if (retry.usedFallback) {
    await rt.step(run.id, "error", "Hermes недоступен на повторе: ответ без инструментов");
    return { text: retry.text.trim() || first.text, status: "failed" };
  }

  const steps2 = await rt.store.listSteps(run.id);
  if (turnHasServiceAction(steps2, retry.startedAt) || isIdleServiceReply(retry.text)) {
    return { text: retry.text, status: "done" };
  }

  await rt.step(run.id, "error", "нет следов работы в сервисе");
  return { text: retry.text.trim() || first.text, status: "failed" };
}
