import { describe, expect, it } from "vitest";
import { accessKindLabel, mergeAccess, type AgentAccess } from "./agent-access";

const saved: AgentAccess = {
  slug: "linear",
  name: "linear",
  kind: "browser",
  accountEmail: "bot@agents.test",
  accountName: "Бот",
  password: "secret",
};

describe("mergeAccess", () => {
  it("берёт имя и способ из живого снимка, пароль — из базы", () => {
    expect(
      mergeAccess(
        [{ slug: "linear", name: "Linear", kind: "mcp", accountEmail: null, accountName: null }],
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
      },
    ]);
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
