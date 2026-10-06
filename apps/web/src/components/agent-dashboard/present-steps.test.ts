import { describe, expect, it } from "vitest";
import type { RunStep } from "@swarm/contracts";
import { forPerson, personStatus, presentDetail, presentSteps } from "./present-steps";

function step(kind: RunStep["kind"], text: string): RunStep {
  return { at: "2026-01-01T00:00:00.000Z", kind, text };
}

describe("presentSteps", () => {
  it("прячет запрос модели и оставляет действия человека", () => {
    const lines = presentSteps([
      step("model", "запрос модели"),
      step("model", "Сейчас вызову инструменты и подключу Linear"),
      step("note", "чат: invite, Linear"),
      step("note", "ищу способ входа в Linear (linear.app)"),
      step("browser", "открыл приглашение в Linear"),
      step("browser", "шаг 2: email_form — поле почты"),
      step("note", "подключён сервис Linear (MCP)"),
      step("note", "cookies Skyvern перенесены в профиль linear"),
      step("browser", "Skyvern: running"),
      step("browser", "Skyvern: принять приглашение"),
      step("error", "Hermes недоступен: ответ без инструментов"),
    ]);

    expect(lines).toEqual([
      "Ищу, как войти в Linear",
      "Открыл приглашение в Linear",
      "Ввожу почту",
      "Подключил Linear",
      "Принимаю приглашение",
      "Не получилось выполнить задачу",
    ]);
  });

  it("не тащит служебные строки в расходы", () => {
    expect(presentDetail("чат: task")).toBeNull();
    expect(presentDetail("поиск в интернете: 3 источник(ов)")).toBe("Ищу в интернете");
  });

  it("убирает имена внутренней кухни из ответа и статуса", () => {
    expect(forPerson("Создал задачу в Linear. Hermes сходил в Skyvern.")).toBe("Создал задачу в Linear.");
    expect(personStatus("Машина создана, Fly готовит образы Hermes и runtime — обычно 1–5 минут")).toBe(
      "Агент запускается — обычно это занимает несколько минут",
    );
    expect(personStatus("Ждёт письмо")).toBe("Ждёт письмо");
  });
});
