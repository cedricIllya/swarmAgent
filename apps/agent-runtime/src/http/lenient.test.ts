import { describe, expect, it } from "vitest";
import { z } from "zod";
import { INSTRUCTION_ALIASES, describeZodError, skyvernPurpose, withAliases } from "./lenient";

describe("withAliases", () => {
  it("подставляет первое найденное имя, не трогая каноническое", () => {
    expect(withAliases({ sessionId: "s1", action: "нажми" }, INSTRUCTION_ALIASES)).toMatchObject({
      sessionId: "s1",
      instruction: "нажми",
    });
    expect(withAliases({ session: "s2", instruction: "ок", text: "нет" }, INSTRUCTION_ALIASES)).toMatchObject({
      sessionId: "s2",
      instruction: "ок",
    });
  });

  it("не падает на пустом и не-объектном теле", () => {
    expect(withAliases(null, INSTRUCTION_ALIASES)).toEqual({});
    expect(withAliases([1], INSTRUCTION_ALIASES)).toEqual({});
  });
});

describe("skyvernPurpose", () => {
  it("угадывает регистрацию по тексту и адресу, иначе вход", () => {
    expect(skyvernPurpose("login to gensite", "https://gensite.ru/login")).toBe("login");
    expect(skyvernPurpose("войти", "https://app.todoist.com/auth/signup")).toBe("signup");
    expect(skyvernPurpose("регистрация", undefined)).toBe("signup");
    expect(skyvernPurpose(undefined, undefined)).toBe("login");
  });
});

describe("describeZodError", () => {
  it("называет недостающее поле и принятые ключи", () => {
    const r = z.object({ purpose: z.string() }).safeParse({ goal: "x" });
    if (r.success) throw new Error("ожидалась ошибка");
    const d = describeZodError(r.error, { goal: "x" });
    expect(d.error).toContain("purpose");
    expect(d.received).toEqual(["goal"]);
  });
});
