import { describe, expect, it } from "vitest";
import { grantSlackAccess, interpretSlackGrant, isSlackConnect } from "../../src/channels/slack-connect";

describe("isSlackConnect", () => {
  it("узнаёт slack и чужой сервис", () => {
    expect(isSlackConnect("https://join.slack.com/t/acme/invite/abc", "acme")).toBe(true);
    expect(isSlackConnect("https://acme.slack.com/signup", "workspace")).toBe(true);
    expect(isSlackConnect("https://example.com/invite", "slack")).toBe(true);
    expect(isSlackConnect("https://example.com/invite", "linear")).toBe(false);
  });
});

describe("grantSlackAccess", () => {
  it("не открывает согласие, если токен уже есть", async () => {
    let opened = false;
    const grant = await grantSlackAccess({
      consentUrl: "https://slack.com/oauth/v2/authorize",
      hasToken: async () => true,
      approve: async () => {
        opened = true;
        return null;
      },
    });
    expect(grant).toEqual({ status: "ready" });
    expect(opened).toBe(false);
  });

  it("после «Разрешить» считает подключение готовым, когда токен появился", async () => {
    let token = false;
    const grant = await grantSlackAccess({
      consentUrl: "https://slack.com/oauth/v2/authorize",
      hasToken: async () => token,
      approve: async () => {
        token = true;
        return { outcome: "allowed", notes: "" };
      },
    });
    expect(grant).toEqual({ status: "ready" });
  });

  it("без токена отдаёт одобрение администратора или застрявшую кнопку", async () => {
    const admin = await grantSlackAccess({
      consentUrl: "https://slack.com/oauth/v2/authorize",
      hasToken: async () => false,
      approve: async () => ({ outcome: "admin", notes: "ждёт админа" }),
    });
    expect(admin).toEqual({ status: "admin", notes: "ждёт админа" });
    const stuck = await grantSlackAccess({
      consentUrl: null,
      hasToken: async () => false,
      approve: async () => null,
    });
    expect(stuck).toEqual({ status: "unconfigured" });
    expect(interpretSlackGrant({ outcome: "nope" })).toMatchObject({ outcome: "stuck" });
  });
});
