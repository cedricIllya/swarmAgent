import { describe, expect, it } from "vitest";
import { escalationNote, humanPage, serviceWorkPrompt } from "./prompts";
import { isMachineSender } from "./inbox";

describe("escalationNote", () => {
  it("points a person at the service page and keeps the Skyvern screen separate", () => {
    expect(humanPage("https://gensite.ru/login")).toBe("https://gensite.ru/login");
    expect(humanPage("https://app.skyvern.com/sessions/1")).toBeNull();
    expect(escalationNote("капча", "https://gensite.ru/login")).toMatch(/gensite\.ru\/login/);
    expect(escalationNote("капча", "https://app.skyvern.com/sessions/1")).toMatch(/взять управление/);
    expect(escalationNote("капча", null)).toMatch(/взять управление некуда/);
  });
});

describe("service work from a notification", () => {
  it("sends the agent into the service and does not answer a mailbox", () => {
    const prompt = serviceWorkPrompt("notification");
    expect(prompt).toMatch(/в самом сервисе/);
    expect(prompt).toMatch(/Отправителю этого письма не отвечай/);
    expect(isMachineSender("Pneumatic <no-reply@pneumatic.app>")).toBe(true);
    expect(isMachineSender("Владелец <owner@cedricillya.online>")).toBe(false);
  });
});
