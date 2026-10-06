import { describe, expect, it } from "vitest";
import { chatTitle, extractLinks, runTitle } from "../../src/llm/prompts";

describe("chat prompts", () => {
  it("pulls links out of a pasted invite", () => {
    expect(extractLinks("зайди https://linear.app/invite/abc) пожалуйста")).toEqual(["https://linear.app/invite/abc"]);
  });

  it("names an invite chat and run after the service", () => {
    expect(chatTitle("invite", "Linear", "https://linear.app/invite/abc")).toBe("Подключение: Linear");
    expect(runTitle("invite", "Linear", "https://linear.app/invite/abc")).toBe("Приглашение: Linear");
    expect(chatTitle("credential", null, "lin_key")).toBe("Ключ: сервис");
    expect(runTitle("task", null, "создай задачу")).toBe("создай задачу");
  });
});