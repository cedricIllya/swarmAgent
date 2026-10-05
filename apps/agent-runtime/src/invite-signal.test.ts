import { describe, expect, it } from "vitest";
import { bareInvite, coerceChatClassification, emailInviteFallback, inviteSignal, isInviteUrl } from "./invite-signal";

const GENSITE = "https://gensite.ru/register?invite=abc123";

describe("invite signal", () => {
  it("treats a register link with invite query as an invite", () => {
    expect(isInviteUrl(GENSITE)).toBe(true);
    expect(isInviteUrl("https://gensite.ru/docs/how-to-register")).toBe(false);
    expect(inviteSignal(GENSITE, [GENSITE])).toMatchObject({
      url: GENSITE,
      service: "Gensite",
      domain: "gensite.ru",
    });
  });

  it("reads the service name from an invitation subject when the link is the app itself", () => {
    const link = "https://gensite.ru/";
    expect(inviteSignal("Приглашение в Gensite", [link, "https://u1.sendgrid.net/track"])).toMatchObject({
      url: link,
      service: "Gensite",
      domain: "gensite.ru",
    });
  });

  it("does not treat a webinar invitation to a blog as onboarding", () => {
    expect(inviteSignal("Приглашение на вебинар", ["https://gensite.ru/blog/webinar"])).toBeNull();
  });

  it("keeps a bare invite link on the onboarding path when the model said task or said nothing", () => {
    const task = { kind: "task" as const, service: null, serviceDomain: null };
    expect(coerceChatClassification(task, GENSITE, [GENSITE]).kind).toBe("invite");
    expect(coerceChatClassification(null, GENSITE, [GENSITE])).toMatchObject({
      kind: "invite",
      service: "Gensite",
      serviceDomain: "gensite.ru",
    });
    expect(bareInvite(GENSITE, [GENSITE])?.url).toBe(GENSITE);
  });

  it("trusts the model when the message is a real task that merely contains an invite link", () => {
    const text = "Посмотри приглашение и напиши, какие там проекты, но сам не регистрируйся и ничего не меняй в аккаунте.";
    const parsed = { kind: "task" as const, service: "Gensite", serviceDomain: "gensite.ru" };
    expect(coerceChatClassification(parsed, `${text} ${GENSITE}`, [GENSITE])).toEqual(parsed);
    expect(coerceChatClassification(null, "просто задача без ссылки", [])).toEqual({
      kind: "task",
      service: null,
      serviceDomain: null,
    });
  });

  it("builds an email invite when classification failed", () => {
    expect(emailInviteFallback("Приглашение в Gensite", "Перейдите по ссылке", [GENSITE])).toMatchObject({
      kind: "invite",
      service: "Gensite",
      serviceDomain: "gensite.ru",
      hasLoginLink: true,
    });
    expect(emailInviteFallback("Счёт за март", "оплатите", ["https://billing.example/invoice/1"])).toBeNull();
  });
});
