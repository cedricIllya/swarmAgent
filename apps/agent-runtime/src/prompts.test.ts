import { describe, expect, it } from "vitest";
import { escalationNote, humanPage, onboardingPrompt, serviceWorkPrompt } from "./prompts";
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

describe("onboardingPrompt cookies", () => {
  it("treats Skyvern cookies transferred into the local profile as saved", () => {
    const text = onboardingPrompt({
      recipe: null,
      discovery: null,
      inviteUrl: "https://app.acme.io/invite/1",
      invite: {
        status: "accepted",
        accountEmail: "bot@agents.test",
        password: "pw",
        steps: 3,
        finalUrl: "https://app.acme.io/",
        notes: "",
        provider: "skyvern",
        cookiesInProfile: true,
      },
      inviteSkipped: null,
      browserAvailable: true,
      slug: "acme",
      engine: { status: "ready", mode: "browser", reason: "ok", liveUrl: null, handoffId: null },
    });
    expect(text).toMatch(/Cookies сохранены/);
    expect(text).toMatch(/serviceSlug "acme"/);
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
