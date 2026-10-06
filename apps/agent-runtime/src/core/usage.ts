import type { RunStep, UsageRecord } from "@swarm/contracts";
import { MAX_DETAILS } from "@swarm/usage";
import type { Store } from "../store";

export interface TaskRef {
  taskId: string;
  taskTitle: string;
}

/** Одна строка в `usage.jsonl` на каждый вызов модели: по ним UI считает деньги. */
export async function recordUsage(
  store: Store,
  task: TaskRef,
  action: string,
  source: UsageRecord["source"],
  r: { model: string; promptTokens: number; completionTokens: number; costUsd: number },
  details?: string[],
): Promise<void> {
  await store.addUsage({
    at: new Date().toISOString(),
    taskId: task.taskId,
    taskTitle: task.taskTitle,
    action,
    source,
    model: r.model,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    costUsd: r.costUsd,
    ...(details?.length ? { details } : {}),
  });
}

/**
 * Что агент успел сделать за один ход Hermes: его заметки через `/runs/:id/step`
 * и шаги runtime (браузер, письма, одобрения) с момента `since`. Служебные записи
 * про сам запрос модели сюда не попадают.
 */
export function turnDetails(steps: RunStep[], since: string): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (s.at < since || s.kind === "model" || s.kind === "error") continue;
    const text = s.text.replace(/\s+/g, " ").trim().slice(0, 140);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= MAX_DETAILS) break;
  }
  return out;
}
