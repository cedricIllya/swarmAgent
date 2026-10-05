import { describe, expect, it, vi } from "vitest";
import { SkyvernClient, interpretInviteOutput, inviteTaskPrompt } from "./browser/skyvern";
import type { Store } from "./store";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeStore() {
  const actions: Array<Record<string, unknown>> = [];
  const sessions: unknown[] = [];
  const store = {
    saveBrowserSession: vi.fn(async (s: unknown) => {
      sessions.push(s);
    }),
    appendBrowserAction: vi.fn(async (_id: string, a: Record<string, unknown>) => {
      actions.push(a);
    }),
    videoPath: (id: string) => `/tmp/${id}.mp4`,
  } as unknown as Store;
  return { store, actions, sessions };
}

describe("inviteTaskPrompt", () => {
  it("tells Skyvern the agent identity, the password and to wait for emailed codes", () => {
    const p = inviteTaskPrompt({ service: "Acme", agentName: "Bot", email: "bot@agents.test", password: "pw!A9" });
    expect(p).toContain("bot@agents.test");
    expect(p).toContain("«Bot»");
    expect(p).toContain("pw!A9");
    expect(p).toMatch(/Сам введи его в поле пароля/);
    expect(p).toMatch(/Имя вводи сам/);
    expect(p).not.toMatch(/Если просят задать пароль/);
    expect(p).toMatch(/жди/i);
    expect(p).toMatch(/Google, Microsoft/);
    expect(p).toContain("pending_approval");
    expect(p).toMatch(/после регистрации/);
    expect(p).toMatch(/тем же паролем/);
  });

  it("signs in to an existing account without resetting the password", () => {
    const p = inviteTaskPrompt({
      service: "Acme",
      agentName: "Bot",
      email: "bot@agents.test",
      password: "known-pw",
      existing: true,
    });
    expect(p).toMatch(/Новый аккаунт не регистрируй/);
    expect(p).toMatch(/forgot\/reset password/);
    expect(p).toContain("known-pw");
  });
});

describe("interpretInviteOutput", () => {
  const ctx = { email: "bot@agents.test", password: "pw" };

  it("accepted only when the run completed and Skyvern says so", () => {
    const r = interpretInviteOutput("completed", { outcome: "accepted", password_set: true, final_url: "https://app.acme.io/home" }, ctx);
    expect(r.status).toBe("accepted");
    expect(r.password).toBe("pw");
    expect(r.finalUrl).toBe("https://app.acme.io/home");
    expect(r.provider).toBe("skyvern");
  });

  it("drops the password when Skyvern never set one (magic link login)", () => {
    const r = interpretInviteOutput("completed", { outcome: "accepted", password_set: false }, ctx);
    expect(r.password).toBeNull();
  });

  it("captcha and needs_human ask for a human; expired fails", () => {
    expect(interpretInviteOutput("completed", { outcome: "captcha", notes: "hCaptcha" }, ctx)).toMatchObject({
      status: "needs_human",
      notes: "hCaptcha",
    });
    expect(interpretInviteOutput("completed", { outcome: "needs_human" }, ctx).status).toBe("needs_human");
    expect(interpretInviteOutput("completed", { outcome: "expired" }, ctx).status).toBe("failed");
  });

  it("does not treat a pending registration as a finished login", () => {
    const waiting = interpretInviteOutput(
      "completed",
      { outcome: "landed", password_set: true, notes: "Заявка на регистрацию ждёт одобрения администратора" },
      ctx,
    );
    expect(waiting).toMatchObject({ status: "needs_human", barrierKind: "pending_approval", password: "pw" });
    expect(interpretInviteOutput("completed", { outcome: "pending_approval", password_set: true }, ctx).barrierKind).toBe("pending_approval");
  });

  it("failed runs carry Skyvern's failure reason", () => {
    const r = interpretInviteOutput("failed", null, { ...ctx, failureReason: "max steps reached" });
    expect(r).toMatchObject({ status: "failed", notes: "max steps reached", password: null });
  });
});

describe("SkyvernClient", () => {
  it("runs the invite task with totp_identifier, forwards emailed codes to it and reports the result", async () => {
    vi.useFakeTimers();
    const { store, actions } = fakeStore();
    const calls: Array<{ url: string; body: unknown }> = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/v1/browser_sessions")) return json({ browser_session_id: "pbs_1", app_url: "https://app.skyvern.com/sessions/pbs_1" });
      if (u.endsWith("/close")) return json({ ok: true });
      if (u.endsWith("/v1/run/tasks")) return json({ run_id: "tsk_1", app_url: "https://app.skyvern.com/runs/tsk_1" });
      if (u.endsWith("/v1/credentials/totp")) return json({ totp_code_id: "tc_1", code: "482913" });
      if (u.endsWith("/v1/runs/tsk_1")) {
        polls++;
        if (polls < 2) return json({ status: "running" });
        return json({
          status: "completed",
          output: { outcome: "accepted", password_set: true, final_url: "https://app.acme.io/" },
          recording_url: null,
        });
      }
      throw new Error(`unexpected ${u}`);
    });
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);

    const pending = client.acceptInvite({
      runId: "run_1",
      url: "https://app.acme.io/invite/abc",
      service: "Acme",
      agentName: "Bot",
      email: "bot@agents.test",
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(client.busy).toBe(true);

    const start = calls.find((c) => c.url.endsWith("/v1/run/tasks"))!.body as Record<string, unknown>;
    expect(start.totp_identifier).toBe("bot@agents.test");
    expect(start.url).toBe("https://app.acme.io/invite/abc");
    expect(start.browser_session_id).toBe("pbs_1");
    const session = calls.find((c) => c.url.endsWith("/v1/browser_sessions"))!.body as Record<string, unknown>;
    expect(session.extensions).toEqual(["captcha-solver"]);
    expect(String(start.prompt)).toContain("bot@agents.test");

    expect(await client.pushCode({ kind: "code", value: "482913" })).toBe(true);
    const totp = calls.find((c) => c.url.endsWith("/v1/credentials/totp"))!.body as Record<string, unknown>;
    expect(totp).toMatchObject({ totp_identifier: "bot@agents.test", task_id: "tsk_1" });
    expect(String(totp.content)).toContain("482913");

    await vi.advanceTimersByTimeAsync(11_000);
    const r = await pending;
    expect(r.status).toBe("accepted");
    expect(r.password).toMatch(/!A9$/);
    expect(r.finalUrl).toBe("https://app.acme.io/");
    expect(client.busy).toBe(false);
    expect(actions.map((a) => a.type)).toEqual(["skyvern.start", "code-from-email", "skyvern.finish"]);
    vi.useRealTimers();
  });

  it("keeps the agent's existing password when re-entering a known account", async () => {
    vi.useFakeTimers();
    const { store } = fakeStore();
    let startBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/browser_sessions")) return json({ browser_session_id: "pbs_2", app_url: null });
      if (u.endsWith("/close")) return json({ ok: true });
      if (u.endsWith("/v1/run/tasks")) {
        startBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ run_id: "tsk_2" });
      }
      return json({ status: "completed", output: { outcome: "accepted", password_set: false } });
    });
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    const pending = client.acceptInvite({
      runId: "run_2",
      url: "https://app.acme.io/invite/abc",
      service: "Acme",
      agentName: "Bot",
      email: "bot@agents.test",
      password: "known-pw",
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const r = await pending;
    expect(r).toMatchObject({ status: "accepted", password: "known-pw" });
    expect(String(startBody!.prompt)).toContain("known-pw");
    vi.useRealTimers();
  });

  it("pushCode is a no-op without an active run", async () => {
    const { store } = fakeStore();
    const fetchImpl = vi.fn();
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    expect(await client.pushCode({ kind: "code", value: "1234" })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
