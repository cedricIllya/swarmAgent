import { describe, expect, it } from "vitest";
import { escalationNote, humanPage } from "./prompts";

describe("escalationNote", () => {
  it("points a person at the service page and keeps the Skyvern screen separate", () => {
    expect(humanPage("https://gensite.ru/login")).toBe("https://gensite.ru/login");
    expect(humanPage("https://app.skyvern.com/sessions/1")).toBeNull();
    expect(escalationNote("капча", "https://gensite.ru/login")).toMatch(/gensite\.ru\/login/);
    expect(escalationNote("капча", "https://app.skyvern.com/sessions/1")).toMatch(/взять управление/);
    expect(escalationNote("капча", null)).toMatch(/взять управление некуда/);
  });
});
