import { describe, expect, it } from "vitest";
import { openRouterCostUsd, parseOpenRouterUsage, parseUsageJsonl, summarizeUsage } from "./index";

describe("usage", () => {
  it("parses openrouter usage", () => {
    expect(parseOpenRouterUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.001,
    });
    expect(parseOpenRouterUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });

  it("берёт списание OpenRouter, а не оценку upstream, когда пришли оба", () => {
    expect(
      openRouterCostUsd({
        usage: { cost: 1.5, cost_details: { upstream_inference_cost: 1.2 } },
      }),
    ).toBe(1.5);
    expect(openRouterCostUsd({ usage: { prompt_tokens: 4, cost_details: { upstream_inference_cost: 0.4 } } })).toBe(0.4);
    expect(openRouterCostUsd({ usage: { cost: 0 } })).toBe(0);
    expect(openRouterCostUsd({ id: "gen-1", usage: { prompt_tokens: 8 } })).toBeNull();
    expect(openRouterCostUsd({ data: { total_cost: 2.25, tokens_prompt: 9, tokens_completion: 3 } })).toBe(2.25);
    expect(parseOpenRouterUsage({ data: { total_cost: 2.25, tokens_prompt: 9, tokens_completion: 3 } })).toEqual({
      promptTokens: 9,
      completionTokens: 3,
      costUsd: 2.25,
    });
  });

  it("aggregates by task and action", () => {
    const records = parseUsageJsonl(
      [
        JSON.stringify({ at: "t", taskId: "a", taskTitle: "A", action: "hermes.turn", source: "hermes", model: "m", promptTokens: 10, completionTokens: 2, costUsd: 0.01 }),
        JSON.stringify({ at: "t", taskId: "a", taskTitle: "A", action: "stagehand.act", source: "stagehand", model: "m", promptTokens: 5, completionTokens: 1, costUsd: 0.02 }),
        JSON.stringify({ at: "t", taskId: "b", taskTitle: "B", action: "hermes.turn", source: "hermes", model: "m", promptTokens: 1, completionTokens: 1, costUsd: 0.001 }),
        "garbage",
      ].join("\n"),
    );
    const s = summarizeUsage(records);
    expect(s.totalCostUsd).toBeCloseTo(0.031);
    expect(s.tasks[0]?.taskId).toBe("a");
    expect(s.tasks[0]?.actions[0]?.action).toBe("stagehand.act");
    expect(s.tasks[0]?.calls).toBe(2);
    expect(s.tasks[0]?.actions[0]?.details).toEqual([]);
  });

  it("collects distinct agent details per action", () => {
    const base = { at: "t", taskId: "a", taskTitle: "A", action: "hermes.turn", source: "hermes", model: "m", promptTokens: 1, completionTokens: 1, costUsd: 0 };
    const s = summarizeUsage([
      { ...base, details: ["вошёл в Linear", "нашёл 3 задачи"] },
      { ...base, details: ["нашёл 3 задачи", "создал задачу X"] },
      { ...base },
    ] as never);
    expect(s.tasks[0]?.actions[0]?.details).toEqual(["вошёл в Linear", "нашёл 3 задачи", "создал задачу X"]);
  });

  it("merges repeated runs that share a title", () => {
    const row = (taskId: string, taskTitle: string, action: string, costUsd: number, details?: string[]) => ({
      at: "t",
      taskId,
      taskTitle,
      action,
      source: "hermes" as const,
      model: "m",
      promptTokens: 10,
      completionTokens: 2,
      costUsd,
      ...(details ? { details } : {}),
    });
    const s = summarizeUsage([
      row("run-1", "Плановая проверка сервисов", "hermes.tick", 0.01, ["ищу в сервисе"]),
      row("run-2", "плановая  проверка сервисов", "hermes.tick", 0.02, ["ищу в сервисе", "нашёл задачу"]),
      row("run-2", "Плановая проверка сервисов", "stagehand.llm", 0.03),
      row("run-3", "Другая задача", "hermes.turn", 0.001),
    ]);
    expect(s.tasks).toHaveLength(2);
    expect(s.totalCostUsd).toBeCloseTo(0.061);
    const check = s.tasks.find((t) => t.taskTitle.toLowerCase() === "плановая проверка сервисов");
    expect(check?.calls).toBe(3);
    expect(check?.promptTokens).toBe(30);
    expect(check?.costUsd).toBeCloseTo(0.06);
    expect(check?.actions.find((a) => a.action === "hermes.tick")).toMatchObject({
      calls: 2,
      costUsd: 0.03,
      details: ["ищу в сервисе", "нашёл задачу"],
    });
    expect(s.tasks.find((t) => t.taskId === "run-3")?.calls).toBe(1);
  });
});
