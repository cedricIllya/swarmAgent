import { describe, expect, it, vi } from "vitest";
import { acceptInvite, generatePassword, type InviteBrowser, type PageState } from "./invite";

/** Браузер-заглушка: состояния страницы выдаются по очереди, действия записываются. */
function fakeBrowser(states: PageState[], opts: { code?: { kind: "code" | "link"; value: string } | null } = {}) {
  let i = 0;
  const acts: string[] = [];
  const gotos: string[] = [];
  const browser: InviteBrowser = {
    goto: async (url) => void gotos.push(url),
    act: async (instruction) => {
      acts.push(instruction);
      return { success: true, message: "" };
    },
    extract: async () => ({ state: states[Math.min(i++, states.length - 1)], hint: "" }),
    waitForCode: vi.fn(async () => (opts.code === undefined ? { kind: "code" as const, value: "482913" } : opts.code)),
    currentUrl: async () => "https://app.acme.io/home",
  };
  return { browser, acts, gotos };
}

const args = { url: "https://app.acme.io/invite/abc", service: "Acme", agentName: "Agent", email: "agent@agents.test" };

describe("acceptInvite", () => {
  it("walks accept → email → code → logged in with the agent's address", async () => {
    const { browser, acts, gotos } = fakeBrowser(["accept_button", "email_form", "code_prompt", "logged_in"]);
    const r = await acceptInvite(browser, args);
    expect(r.status).toBe("accepted");
    expect(r.accountEmail).toBe("agent@agents.test");
    expect(r.password).toBeNull();
    expect(gotos).toEqual(["https://app.acme.io/invite/abc"]);
    expect(acts[0]).toMatch(/принять приглашение/i);
    expect(acts[1]).toContain("agent@agents.test");
    expect(acts[2]).toContain("482913");
  });

  it("creates and returns a password when the service wants a signup form", async () => {
    const { browser, acts } = fakeBrowser(["auth_choice", "signup_form", "logged_in"]);
    const r = await acceptInvite(browser, args);
    expect(r.status).toBe("accepted");
    expect(r.password).toBeTruthy();
    expect(acts[0]).toMatch(/по электронной почте/);
    expect(acts[1]).toContain(r.password!);
  });

  it("reuses a known password instead of inventing a new one", async () => {
    const { browser, acts } = fakeBrowser(["password_form", "logged_in"]);
    const r = await acceptInvite(browser, { ...args, password: "known-secret" });
    expect(r.status).toBe("accepted");
    expect(r.password).toBeNull();
    expect(acts[0]).toContain("known-secret");
  });

  it("opens a magic link from the mailbox", async () => {
    const { browser, gotos } = fakeBrowser(["email_form", "magic_link_sent", "logged_in"], {
      code: { kind: "link", value: "https://app.acme.io/magic/xyz" },
    });
    const r = await acceptInvite(browser, args);
    expect(r.status).toBe("accepted");
    expect(gotos).toContain("https://app.acme.io/magic/xyz");
  });

  it("stops when the service must approve the registration", async () => {
    const r = await acceptInvite(fakeBrowser(["signup_form", "pending_approval"]).browser, args);
    expect(r).toMatchObject({ status: "needs_human", barrierKind: "pending_approval" });
    expect(r.password).toBeTruthy();
  });

  it("asks for a human when the code never arrives or a captcha shows up", async () => {
    const noCode = fakeBrowser(["email_form", "code_prompt"], { code: null });
    expect((await acceptInvite(noCode.browser, args)).status).toBe("needs_human");
    const captcha = fakeBrowser(["captcha"]);
    expect((await acceptInvite(captcha.browser, args)).status).toBe("needs_human");
  });

  it("fails on expired invites and on pages that never change", async () => {
    expect((await acceptInvite(fakeBrowser(["expired"]).browser, args)).status).toBe("failed");
    const stuck = await acceptInvite(fakeBrowser(["other"]).browser, { ...args, maxSteps: 10 });
    expect(stuck.status).toBe("failed");
    expect(stuck.steps).toBeLessThanOrEqual(5);
  });
});

describe("generatePassword", () => {
  it("is long, unique and mixes character classes", () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[^A-Za-z0-9]/);
  });
});
