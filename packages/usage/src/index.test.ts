import { describe, expect, it } from "vitest";
import { parseOpenRouterUsage, parseUsageJsonl, summarizeUsage } from "./index";

describe("usage", () => {
  it("parses openrouter usage", () => {
    expect(parseOpenRouterUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.001,
    });
    expect(parseOpenRouterUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
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
  });
});
