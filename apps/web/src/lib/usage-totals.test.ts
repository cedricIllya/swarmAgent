import { describe, expect, it } from "vitest";
import { savedUsage, sumUsage, usageCaveat, type AgentUsage, type UsageRowLike } from "./usage-totals";

function agent(over: Partial<AgentUsage> = {}): AgentUsage {
  return {
    id: "agt_1",
    name: "Анна",
    totalCostUsd: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    source: "live",
    at: "2026-10-06T00:00:00.000Z",
    ...over,
  };
}

function row(over: Partial<UsageRowLike> = {}): UsageRowLike {
  return {
    id: "agt_1",
    name: "Анна",
    status: "running",
    usageCostUsd: null,
    usagePromptTokens: null,
    usageCompletionTokens: null,
    usageAt: null,
    ...over,
  };
}

describe("sumUsage", () => {
  it("складывает деньги и токены по всем агентам", () => {
    const total = sumUsage([
      agent({ totalCostUsd: 0.5, totalPromptTokens: 1000, totalCompletionTokens: 200 }),
      agent({ id: "agt_2", totalCostUsd: 1.25, totalPromptTokens: 40, totalCompletionTokens: 10, source: "saved" }),
      agent({ id: "agt_3", source: "empty", at: null }),
    ]);
    expect(total.totalCostUsd).toBeCloseTo(1.75);
    expect(total.totalPromptTokens).toBe(1040);
    expect(total.totalCompletionTokens).toBe(210);
    expect(total.agents).toHaveLength(3);
  });

  it("без агентов — нули", () => {
    expect(sumUsage([])).toEqual({ totalCostUsd: 0, totalPromptTokens: 0, totalCompletionTokens: 0, agents: [] });
  });
});

describe("usageCaveat", () => {
  it("молчит, когда все цифры живые или агенты ещё не запускались", () => {
    expect(usageCaveat([agent(), agent({ id: "agt_2", source: "empty", at: null })])).toBeNull();
  });

  it("предупреждает про спящих", () => {
    expect(usageCaveat([agent({ source: "saved" })])).toMatch(/before it went to sleep/);
  });

  it("называет тех, кого не учли", () => {
    const text = usageCaveat([
      agent({ source: "unknown", at: null }),
      agent({ id: "agt_2", name: "Пётр", source: "unknown", at: null }),
      agent({ id: "agt_3", source: "saved" }),
    ]);
    expect(text).toMatch(/Not included: Анна, Пётр/);
    expect(text).toMatch(/before it went to sleep/);
  });
});

describe("savedUsage", () => {
  it("берёт итоги из строки агента", () => {
    const at = new Date("2026-10-05T10:00:00Z");
    const u = savedUsage(row({ usageCostUsd: 2.5, usagePromptTokens: 300, usageCompletionTokens: 50, usageAt: at }));
    expect(u).toMatchObject({ totalCostUsd: 2.5, totalPromptTokens: 300, totalCompletionTokens: 50, source: "saved" });
    expect(u.at).toBe(at.toISOString());
  });

  it("работающий агент без отчёта — unknown, остальные — empty", () => {
    expect(savedUsage(row()).source).toBe("unknown");
    expect(savedUsage(row({ status: "provisioning" })).source).toBe("empty");
    expect(savedUsage(row({ status: "failed" })).source).toBe("empty");
  });

  it("пустая стоимость при известных токенах читается как ноль", () => {
    const u = savedUsage(row({ usagePromptTokens: 10, usageCompletionTokens: 0, usageAt: new Date() }));
    expect(u.totalCostUsd).toBe(0);
    expect(u.source).toBe("saved");
  });
});
