import { describe, expect, it } from "vitest";
import type { RunStep } from "@swarm/contracts";
import { forPerson, personStatus, presentDetail, presentDetails, presentSteps } from "./present-steps";

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
      "Looking for a way into Linear",
      "Открыл приглашение в Linear",
      "Entering the email",
      "Connected Linear",
      "Принимаю приглашение",
      "Couldn't complete the task",
    ]);
  });

  it("не тащит служебные строки в расходы", () => {
    expect(presentDetail("чат: task")).toBeNull();
    expect(presentDetail("поиск в интернете: 3 источник(ов)")).toBe("Searching the web");
  });

  it("схлопывает одинаковые заметки расхода", () => {
    expect(
      presentDetails([
        "поиск в интернете: linear",
        "чат: task",
        "нашёл 3 задачи",
        "поиск в интернете: ещё раз",
        "нашёл 3 задачи",
      ]),
    ).toEqual(["Searching the web", "Нашёл 3 задачи"]);
  });

  it("убирает имена внутренней кухни из ответа и статуса", () => {
    expect(forPerson("Создал задачу в Linear. Hermes сходил в Skyvern.")).toBe("Создал задачу в Linear.");
    expect(personStatus("Машина создана, Fly готовит образы Hermes и runtime — обычно 1–5 минут")).toBe(
      "The agent is starting — this usually takes a few minutes",
    );
    expect(personStatus("Ждёт письмо")).toBe("Ждёт письмо");
  });
});
