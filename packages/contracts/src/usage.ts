import { z } from "zod";

/**
 * Одна строка `usage.jsonl` на машине агента: один вызов модели.
 */
export const UsageRecordSchema = z.object({
  at: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  /** Что именно делали: `hermes.turn`, `stagehand.act`, `skyvern.login`, `classify.email`. */
  action: z.string(),
  source: z.enum(["hermes", "stagehand", "skyvern", "runtime"]),
  model: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  /** Доллары, как их вернул OpenRouter. */
  costUsd: z.number().nonnegative(),
});

export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const UsageByActionSchema = z.object({
  action: z.string(),
  calls: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  costUsd: z.number(),
});

export const UsageByTaskSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  calls: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  costUsd: z.number(),
  actions: z.array(UsageByActionSchema),
});

export const UsageSummarySchema = z.object({
  totalCostUsd: z.number(),
  totalPromptTokens: z.number().int(),
  totalCompletionTokens: z.number().int(),
  tasks: z.array(UsageByTaskSchema),
});

export type UsageByAction = z.infer<typeof UsageByActionSchema>;
export type UsageByTask = z.infer<typeof UsageByTaskSchema>;
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
