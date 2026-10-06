import { describe, expect, it } from "vitest";
import { splitCodes } from "./secret-text";

describe("splitCodes", () => {
  it("оставляет обычный текст как есть", () => {
    expect(splitCodes("аккаунт сохранён, пароль в журнале")).toEqual([
      { type: "text", value: "аккаунт сохранён, пароль в журнале" },
    ]);
  });

  it("вынимает код подтверждения из письма", () => {
    expect(splitCodes("код подтверждения из письма: 482910")).toEqual([
      { type: "text", value: "код подтверждения из письма: " },
      { type: "code", value: "482910" },
    ]);
  });

  it("вынимает код из скобок и не захватывает точку", () => {
    expect(splitCodes("verification: письмо (код 482910).")).toEqual([
      { type: "text", value: "verification: письмо (код " },
      { type: "code", value: "482910" },
      { type: "text", value: ")." },
    ]);
  });

  it("вынимает код, который передали в задачу входа", () => {
    expect(splitCodes("извлечён код AB-12")).toEqual([
      { type: "text", value: "извлечён код " },
      { type: "code", value: "AB-12" },
    ]);
  });
});
