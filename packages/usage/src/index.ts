import type { UsageByAction, UsageByTask, UsageRecord, UsageSummary } from "@swarm/contracts";

/**
 * OpenRouter возвращает `usage` в ответе chat completions; с `usage: {include: true}`
 * там есть и `cost` в долларах.
 */
export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  cost_details?: { upstream_inference_cost?: number };
}

export function parseOpenRouterUsage(body: unknown): {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
} {
  const usage = (body as { usage?: OpenRouterUsage } | null)?.usage ?? {};
  return {
    promptTokens: Math.max(0, Math.trunc(usage.prompt_tokens ?? 0)),
    completionTokens: Math.max(0, Math.trunc(usage.completion_tokens ?? 0)),
    costUsd: Math.max(0, usage.cost ?? 0),
  };
}

export function parseUsageJsonl(text: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as UsageRecord);
    } catch {
      // битая строка не должна ломать всю статистику
    }
  }
  return out;
}

/** Сколько заметок агента показываем под одним действием, чтобы таблица не разрасталась. */
export const MAX_DETAILS = 12;

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const tasks = new Map<string, UsageByTask & { byAction: Map<string, UsageByAction> }>();
  let totalCostUsd = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const r of records) {
    totalCostUsd += r.costUsd;
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;

    let task = tasks.get(r.taskId);
    if (!task) {
      task = {
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        actions: [],
        byAction: new Map(),
      };
      tasks.set(r.taskId, task);
    }
    task.calls += 1;
    task.promptTokens += r.promptTokens;
    task.completionTokens += r.completionTokens;
    task.costUsd += r.costUsd;
    if (r.taskTitle && !task.taskTitle) task.taskTitle = r.taskTitle;

    let action = task.byAction.get(r.action);
    if (!action) {
      action = { action: r.action, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, details: [] };
      task.byAction.set(r.action, action);
    }
    action.calls += 1;
    action.promptTokens += r.promptTokens;
    action.completionTokens += r.completionTokens;
    action.costUsd += r.costUsd;
    for (const d of r.details ?? []) {
      if (action.details.length >= MAX_DETAILS) break;
      if (!action.details.includes(d)) action.details.push(d);
    }
  }

  const list: UsageByTask[] = [...tasks.values()]
    .map(({ byAction, ...t }) => ({
      ...t,
      actions: [...byAction.values()].sort((a, b) => b.costUsd - a.costUsd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return { totalCostUsd, totalPromptTokens, totalCompletionTokens, tasks: list };
}

export function emptyUsage(): UsageSummary {
  return { totalCostUsd: 0, totalPromptTokens: 0, totalCompletionTokens: 0, tasks: [] };
}
