import type { UsageRecord } from "@swarm/contracts";
import type { Store } from "./store";

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
  });
}
