import { describe, expect, it } from "vitest";
import { parseUserQuestion } from "@swarm/contracts";

const TRELLO = [
  "Я проверю, какие задачи на мне стоят в Trello, и выполню их. Сначала получу доступ к Trello через API:",
  "```bash",
  'curl -X GET "https://api.trello.com/1/members/me/cards" \\',
  '-H "```',
  "Дайте мне момент, чтобы подключиться к вашему Trello и посмотреть назначенные задачи.",
  "Нужно, чтобы я получил ваш API токен Trello или подключился через браузер.",
  "Какой способ удобнее: 1. Если у вас есть API ключ и токен Trello — передайте их 2. Или я могу открыть Trello в браузере и выполнить задачу там На каком способе мы работаем?",
].join(" ");

describe("parseUserQuestion", () => {
  it("reads numbered choices from one paragraph", () => {
    const q = parseUserQuestion(TRELLO);
    expect(q?.options).toEqual([
      "Если у вас есть API ключ и токен Trello — передайте их",
      "Или я могу открыть Trello в браузере и выполнить задачу там",
    ]);
    expect(q?.prompt).toContain("Какой способ удобнее:");
    expect(q?.prompt).toContain("На каком способе мы работаем?");
    expect(q?.prompt).not.toContain("curl");
  });

  it("reads a list broken onto its own lines", () => {
    const q = parseUserQuestion(
      ["Какой способ удобнее:", "1. Передам ключ", "2. Открой браузер", "На каком способе мы работаем?"].join("\n"),
    );
    expect(q?.options).toEqual(["Передам ключ", "Открой браузер"]);
    expect(q?.prompt).toContain("На каком способе мы работаем?");
  });

  it("ignores a finished report that only lists results", () => {
    expect(parseUserQuestion("Сделал две задачи:\n1. Починить вход\n2. Закрыть счёт")).toBeNull();
  });
});
