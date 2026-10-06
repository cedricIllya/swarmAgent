import { describe, expect, it } from "vitest";
import { accessKindLabel, mergeAccess, taskWatchLabel, type AgentAccess } from "./agent-access";

const saved: AgentAccess = {
  slug: "linear",
  name: "linear",
  kind: "browser",
  accountEmail: "bot@agents.test",
  accountName: "Бот",
  password: "secret",
  watchesTasks: null,
};

describe("mergeAccess", () => {
  it("берёт имя и способ из живого снимка, пароль — из базы", () => {
    expect(
      mergeAccess(
        [{ slug: "linear", name: "Linear", kind: "mcp", accountEmail: null, accountName: null, watchesTasks: true }],
        [saved],
      ),
    ).toEqual([
      {
        slug: "linear",
        name: "Linear",
        kind: "mcp",
        accountEmail: "bot@agents.test",
        accountName: "Бот",
        password: "secret",
        watchesTasks: true,
      },
    ]);
  });

  it("оставляет известную пометку, если живой снимок её ещё не прислал", () => {
    expect(mergeAccess([{ slug: "linear", name: "Linear", kind: "mcp" }], [{ ...saved, watchesTasks: false }])[0]?.watchesTasks).toBe(
      false,
    );
  });

  it("показывает доступ из базы, даже если машина его ещё не отдала", () => {
    expect(mergeAccess([], [saved])).toEqual([saved]);
  });
});

describe("accessKindLabel", () => {
  it("называет способ по-русски там, где это слово", () => {
    expect(accessKindLabel("mcp")).toBe("MCP");
    expect(accessKindLabel("api")).toBe("API");
    expect(accessKindLabel("browser")).toBe("браузер");
  });
});

describe("taskWatchLabel", () => {
  it("называет три состояния", () => {
    expect(taskWatchLabel(true).text).toBe("задачи");
    expect(taskWatchLabel(false).text).toBe("без задач");
    expect(taskWatchLabel(null).text).toBe("не ясно");
    expect(taskWatchLabel(undefined).text).toBe("не ясно");
  });
});
