import { describe, expect, it, vi } from "vitest";
import type { Run } from "@swarm/contracts";
import { looksLikeServiceApprovalWait } from "./connect";
import { loginAfterApproval, pickInviteLink, resumeTarget, runConnectFollowup } from "./onboarding";
import { secretFollowupPrompt, systemPrompt } from "./prompts";
import type { AgentRuntime } from "./runtime";

describe("pickInviteLink", () => {
  it("prefers an invite-looking link on the service domain", () => {
    const links = [
      "https://u1.sendgrid.net/track/abc",
      "https://acme.io/privacy",
      "https://app.acme.io/invite/xyz",
      "https://acme.io/blog/new",
    ];
    expect(pickInviteLink(links, "acme.io")).toBe("https://app.acme.io/invite/xyz");
  });

  it("falls back to any non-noise link when the domain is unknown", () => {
    expect(pickInviteLink(["https://u1.sendgrid.net/x", "https://acme.io/join/abc"], null)).toBe("https://acme.io/join/abc");
    expect(pickInviteLink(["https://mailgun.org/u/1"], "acme.io")).toBeNull();
  });
});

describe("resume after a parked signup", () => {
  it("opens the app the signup landed on, not the spent invite link", () => {
    const invite = "https://email.pneumatic.app/e/c/token";
    expect(loginAfterApproval(invite, "https://my.pneumatic.app/auth/pending")).toBe("https://my.pneumatic.app/");
    expect(loginAfterApproval("https://app.acme.io/invite/xyz", null)).toBe("https://app.acme.io/");
    expect(loginAfterApproval("https://app.acme.io/invite/xyz", "https://evil.example/phish")).toBe("https://app.acme.io/");
  });

  it("keeps a captcha retry on the invite link and a parked signup on the app", () => {
    const invite = "https://email.pneumatic.app/e/c/token";
    const recipe = { browser: { loginUrl: invite, appUrl: "https://my.pneumatic.app/" } };
    expect(resumeTarget({ serviceWait: false, url: invite }, recipe)).toBe(invite);
    expect(resumeTarget({ serviceWait: true, url: invite, loginUrl: "https://my.pneumatic.app/" }, recipe)).toBe("https://my.pneumatic.app/");
    expect(
      resumeTarget({ serviceWait: true, url: "https://app.acme.io/invite/abc" }, { browser: { loginUrl: "https://app.acme.io/invite/abc", appUrl: "https://app.acme.io/invite/abc" } }),
    ).toBe("https://app.acme.io/");
  });
});

describe("runConnectFollowup", () => {
  it("does not open an approval card when the model repeats the waiting phrase", async () => {
    const phrase = "Заявка на регистрацию ждёт одобрения в сервисе, почта: a@b.c.";
    const open = vi.fn();
    const finishRun = vi.fn(async (run: Run, status: string, summary: string) => {
      Object.assign(run, { status, summary, finishedAt: "now" });
    });
    const addChat = vi.fn();
    const run = { id: "run-1", status: "running" } as Run;
    const startedAt = "2026-01-01T00:00:00.000Z";
    const rt = {
      think: async () => ({ text: phrase, usedFallback: false, startedAt }),
      store: {
        getRun: async () => ({ ...run, status: "running" }),
        listSteps: async () => [{ at: startedAt, kind: "note", text: "подключён сервис Pneumatic (API)" }],
      },
      handoffs: { open },
      finishRun,
      addChat,
      step: vi.fn(),
    } as unknown as AgentRuntime;

    await runConnectFollowup(rt, run, "chat-1", "Pneumatic", { status: "needs_secret", mode: "api" });

    expect(open).not.toHaveBeenCalled();
    expect(finishRun).toHaveBeenCalledWith(run, "done", phrase);
    expect(addChat).toHaveBeenCalledWith(expect.objectContaining({ role: "agent", text: phrase, chatId: "chat-1" }));
  });

  it("does not teach the model the phrase that used to open the card", () => {
    const prompt = secretFollowupPrompt("Pneumatic", "api");
    expect(looksLikeServiceApprovalWait(prompt)).toBe(false);
    expect(prompt).toContain("Если секрет выпустить не удалось");
    const system = systemPrompt({
      agentName: "Бот",
      email: "bot@example.com",
      ownerEmail: null,
      autonomous: false,
      runtimePort: 8787,
      services: null,
    });
    expect(looksLikeServiceApprovalWait(system)).toBe(false);
  });
});
