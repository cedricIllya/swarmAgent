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

function nonNegative(value: unknown): number | null {
  if (typeof value === "boolean" || value == null) return null;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Сколько OpenRouter списал за ответ.
 * `usage.cost` — сумма с аккаунта. `upstream_inference_cost` и `total_cost`
 * подставляются, только когда этой суммы в ответе нет.
 * `null` — стоимости в теле нет (это не то же самое, что бесплатный вызов за $0).
 */
export function openRouterCostUsd(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as {
    usage?: OpenRouterUsage;
    data?: { total_cost?: unknown; usage?: unknown };
  };
  const usage = record.usage;
  if (usage && typeof usage === "object") {
    const billed = nonNegative(usage.cost);
    if (billed != null) return billed;
    const upstream = nonNegative(usage.cost_details?.upstream_inference_cost);
    if (upstream != null) return upstream;
  }
  const data = record.data;
  if (data && typeof data === "object") {
    const total = nonNegative(data.total_cost);
    if (total != null) return total;
    const usageField = nonNegative(data.usage);
    if (usageField != null) return usageField;
  }
  return null;
}

export function parseOpenRouterUsage(body: unknown): {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
} {
  const record = (body ?? {}) as {
    usage?: OpenRouterUsage;
    data?: { tokens_prompt?: number; tokens_completion?: number };
  };
  const usage = record.usage ?? {};
  const prompt = usage.prompt_tokens ?? record.data?.tokens_prompt ?? 0;
  const completion = usage.completion_tokens ?? record.data?.tokens_completion ?? 0;
  return {
    promptTokens: Math.max(0, Math.trunc(Number(prompt) || 0)),
    completionTokens: Math.max(0, Math.trunc(Number(completion) || 0)),
    costUsd: openRouterCostUsd(body) ?? 0,
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

  return { totalCostUsd, totalPromptTokens, totalCompletionTokens, tasks: mergeSameWork(list) };
}

/** Одинаковое название — одна и та же работа, повторённая новым прогоном. */
function workKey(task: UsageByTask): string {
  const title = task.taskTitle.replace(/\s+/g, " ").trim().toLowerCase();
  return title || task.taskId;
}

/**
 * Плановая проверка и прочие повторы с тем же названием схлопываются в одну строку.
 * Иначе таблица расходов растёт с каждым прогоном, хотя действие то же.
 */
function mergeSameWork(tasks: UsageByTask[]): UsageByTask[] {
  const grouped = new Map<string, UsageByTask>();
  for (const task of tasks) {
    const prev = grouped.get(workKey(task));
    if (!prev) {
      grouped.set(workKey(task), {
        ...task,
        taskTitle: task.taskTitle.replace(/\s+/g, " ").trim(),
        actions: task.actions.map((action) => ({ ...action, details: [...action.details] })),
      });
      continue;
    }
    prev.calls += task.calls;
    prev.promptTokens += task.promptTokens;
    prev.completionTokens += task.completionTokens;
    prev.costUsd += task.costUsd;
    for (const action of task.actions) {
      const into = prev.actions.find((item) => item.action === action.action);
      if (!into) {
        prev.actions.push({ ...action, details: [...action.details] });
        continue;
      }
      into.calls += action.calls;
      into.promptTokens += action.promptTokens;
      into.completionTokens += action.completionTokens;
      into.costUsd += action.costUsd;
      for (const detail of action.details) {
        if (into.details.length >= MAX_DETAILS) break;
        if (!into.details.includes(detail)) into.details.push(detail);
      }
    }
  }
  return [...grouped.values()]
    .map((task) => ({
      ...task,
      actions: [...task.actions].sort((a, b) => b.costUsd - a.costUsd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

export function emptyUsage(): UsageSummary {
  return { totalCostUsd: 0, totalPromptTokens: 0, totalCompletionTokens: 0, tasks: [] };
}
