import { describe, expect, it, vi } from "vitest";
import type { Run } from "@swarm/contracts";
import { looksLikeServiceApprovalWait } from "../../src/onboarding/connect";
import { keySearchStart, loginAfterApproval, pickInviteLink, resumeTarget, runConnectFollowup } from "../../src/onboarding";
import { secretFollowupPrompt, systemPrompt } from "../../src/llm/prompts";
import type { AgentRuntime } from "../../src/runtime";

describe("keySearchStart", () => {
  const invite = "https://trello.com/invite/b/6abfb6bcf0af46690e460ee0/ATTI76f1f8a4c0958c0d3f01bae93356106f96EA3371/%D1%82%D0%B5%D1%81%D1%82";

  it("starts from the service root when final_url is really the invite link in disguise", () => {
    expect(keySearchStart("https://trello.com/b/ATTI76f1f8a4c0958c0d3f01bae93356106f96EA3371/%D1%82%D0%B5%D1%81%D1%82", invite)).toBe("https://trello.com/");
    expect(keySearchStart(invite, invite)).toBe("https://trello.com/");
    expect(keySearchStart("https://app.acme.io/invite/xyz", "https://app.acme.io/invite/xyz")).toBe("https://app.acme.io/");
  });

  it("keeps a real landing page", () => {
    expect(keySearchStart("https://trello.com/b/AbCdEfGh/%D1%82%D0%B5%D1%81%D1%82", invite)).toBe("https://trello.com/b/AbCdEfGh/%D1%82%D0%B5%D1%81%D1%82");
    expect(keySearchStart("https://my.pneumatic.app/workflows", null)).toBe("https://my.pneumatic.app/workflows");
  });
});

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

  it("называет кабинет, slug и путь к токену, чтобы модель не искала сервис наугад", () => {
    const prompt = secretFollowupPrompt(
      "Gensite",
      "mcp",
      {
        slug: "gensite",
        kind: "mcp",
        appUrl: "https://gensite.ru/dashboard",
        hint: "Токен gs1 из кабинета: Настройки → MCP.",
        docsUrl: "https://gensite.ru/docs/mcp",
        cookiesInProfile: true,
      },
      "bot@example.com",
    );
    expect(prompt).toContain("gensite.ru");
    expect(prompt).toContain("https://gensite.ru/dashboard");
    expect(prompt).toContain('serviceSlug "gensite"');
    expect(prompt).toContain("Настройки → MCP");
    expect(prompt).toContain("https://gensite.ru/docs/mcp");
    expect(prompt).toContain("не ищи его в интернете");
    expect(prompt).toContain("POST /browser/save-token");
    expect(prompt).not.toContain('"token":"<значение>"');
    expect(looksLikeServiceApprovalWait(prompt)).toBe(false);
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
