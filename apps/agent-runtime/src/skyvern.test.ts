import { describe, expect, it, vi } from "vitest";
import {
  SkyvernClient,
  countCaptchaFailures,
  interpretInviteOutput,
  inviteTaskPrompt,
  skyvernInboxContent,
  totpTarget,
  workflowRunIdFrom,
} from "./browser/skyvern";
import type { Store } from "./store";

describe("totpTarget", () => {
  it("addresses a 2.0 task by workflow_run_id because Skyvern rejects tsk_v2_ as task_id", () => {
    expect(totpTarget({ skyvernRunId: "tsk_v2_1", workflowRunId: "wr_1" })).toEqual({ workflow_run_id: "wr_1" });
    expect(totpTarget({ skyvernRunId: "tsk_v2_1", workflowRunId: null })).toEqual({});
    expect(totpTarget({ skyvernRunId: "tsk_1", workflowRunId: null })).toEqual({ task_id: "tsk_1" });
  });

  it("reads wr_ from the app url", () => {
    expect(workflowRunIdFrom("https://app.skyvern.com/runs/wr_582212643708188894")).toBe("wr_582212643708188894");
    expect(workflowRunIdFrom("https://app.skyvern.com/runs/tsk_1")).toBeNull();
    expect(workflowRunIdFrom(null)).toBeNull();
  });
});

function captchaStep(status: string, success: boolean | null) {
  return {
    status,
    output: {
      actions_and_results: success === null ? [] : [[{ action_type: "solve_captcha" }, [{ success }]]],
    },
  };
}

describe("countCaptchaFailures", () => {
  it("counts trailing failed solve_captcha steps and ignores the running retry", () => {
    const steps = [
      { status: "completed", output: { actions_and_results: [[{ action_type: "click" }, [{ success: true }]]] } },
      captchaStep("failed", false),
      captchaStep("failed", false),
      captchaStep("running", null),
    ];
    expect(countCaptchaFailures(steps as never)).toBe(2);
  });

  it("is zero when the captcha was solved or there was none", () => {
    expect(countCaptchaFailures([captchaStep("failed", false), captchaStep("completed", true)] as never)).toBe(0);
    expect(countCaptchaFailures([{ status: "completed", output: { actions_and_results: [[{ action_type: "click" }, [{ success: true }]]] } }] as never)).toBe(0);
    expect(countCaptchaFailures([])).toBe(0);
  });
});

describe("interpretInviteOutput with a captcha stall", () => {
  it("hands the same session to a human instead of failing", () => {
    const r = interpretInviteOutput("terminated", null, { email: "a@b.c", password: "p", captchaStall: true });
    expect(r.status).toBe("needs_human");
    expect(r.barrierKind).toBe("captcha");
  });

  it("does not override a completed task", () => {
    const r = interpretInviteOutput("completed", { outcome: "landed", final_url: "https://x" }, { email: "a@b.c", password: "p", captchaStall: true });
    expect(r.status).toBe("accepted");
  });
});

describe("skyvernInboxContent", () => {
  it("puts the subject on the first line and keeps the plain text, including a link", () => {
    const content = skyvernInboxContent({
      subject: "Sign in",
      text: "Your code is 482913.\nhttps://app.acme.io/magic",
      html: "<p>ignore</p>",
    });
    expect(content).toBe("Sign in\nYour code is 482913.\nhttps://app.acme.io/magic");
  });

  it("strips tags and collapses whitespace when there is no plain text", () => {
    const content = skyvernInboxContent({
      subject: "Sign in",
      text: "",
      html: "<p>Click <a href=\"https://app.acme.io/magic\">here</a></p>  <b>4 8 2 9</b>",
    });
    expect(content).toBe("Sign in\nClick here 4 8 2 9 https://app.acme.io/magic");
  });

  it("caps the letter at 6000 characters", () => {
    const content = skyvernInboxContent({ subject: "S", text: "x".repeat(7000), html: "" });
    expect(content.length).toBe(6000);
    expect(content.startsWith("S\n")).toBe(true);
  });
});

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
    expect(p).toMatch(/подожди/);
    expect(p).toMatch(/будет передано в эту задачу/);
    expect(p).toMatch(/не бери его со страницы/);
    expect(p).toMatch(/не пропускай этот шаг/);
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
      if (u.endsWith("/v1/browser_sessions")) {
        return json({
          browser_session_id: "pbs_1",
          app_url: "https://app.skyvern.com/sessions/pbs_1",
          browser_address: "wss://sessions.skyvern.com/pbs_1",
        });
      }
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
    expect(await client.browserAddress("pbs_1")).toBe("wss://sessions.skyvern.com/pbs_1");

    const start = calls.find((c) => c.url.endsWith("/v1/run/tasks"))!.body as Record<string, unknown>;
    expect(start.totp_identifier).toBe("bot@agents.test");
    expect(start.url).toBe("https://app.acme.io/invite/abc");
    expect(start.browser_session_id).toBe("pbs_1");
    const session = calls.find((c) => c.url.endsWith("/v1/browser_sessions"))!.body as Record<string, unknown>;
    expect(session.extensions).toEqual(["captcha-solver"]);
    expect(String(start.prompt)).toContain("bot@agents.test");

    const letter = "Verify\nYour code is 482913\nhttps://app.acme.io/magic";
    expect(await client.offerEmail(letter)).toMatchObject({ taken: true, posted: true, code: "482913" });
    expect(client.wasForwarded(letter)).toBe(true);
    const totp = calls.find((c) => c.url.endsWith("/v1/credentials/totp"))!.body as Record<string, unknown>;
    expect(totp).toEqual({
      totp_identifier: "bot@agents.test",
      task_id: "tsk_1",
      source: "Acme-inbox",
      content: letter,
    });
    expect(String(start.prompt)).toMatch(/будет передано в эту задачу/);

    await vi.advanceTimersByTimeAsync(11_000);
    const r = await pending;
    expect(r.status).toBe("accepted");
    expect(r.password).toMatch(/!A9$/);
    expect(r.finalUrl).toBe("https://app.acme.io/");
    expect(client.busy).toBe(false);
    expect(actions.map((a) => a.type)).toEqual(["skyvern.start", "code-from-email", "skyvern.finish"]);
    vi.useRealTimers();
  });

  it("fetches browser_address when create response omits it", async () => {
    const { store } = fakeStore();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/v1/browser_sessions")) return json({ browser_session_id: "pbs_3", app_url: null });
      if (u.endsWith("/v1/browser_sessions/pbs_3")) {
        return json({ browser_session_id: "pbs_3", browser_address: "wss://sessions.skyvern.com/pbs_3" });
      }
      if (u.endsWith("/close")) return json({ ok: true });
      throw new Error(`unexpected ${u}`);
    });
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    const opened = await client.openBrowserSession();
    expect(opened.browserAddress).toBe("wss://sessions.skyvern.com/pbs_3");
    expect(await client.browserAddress("pbs_3")).toBe("wss://sessions.skyvern.com/pbs_3");
    await client.closeBrowserSession("pbs_3");
  });

  it("exportStorageState requires a CDP address", async () => {
    const { store } = fakeStore();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/v1/browser_sessions")) return json({ browser_session_id: "pbs_4", app_url: null });
      if (u.endsWith("/v1/browser_sessions/pbs_4")) return json({ browser_session_id: "pbs_4", browser_address: null });
      if (u.endsWith("/close")) return json({ ok: true });
      throw new Error(`unexpected ${u}`);
    });
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    await client.openBrowserSession();
    await expect(client.exportStorageState("pbs_4")).rejects.toThrow(/browser_address/);
    await client.closeBrowserSession("pbs_4");
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

  it("remembers a letter that arrives before the task and posts it unchanged when the task starts", async () => {
    vi.useFakeTimers();
    const { store } = fakeStore();
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/v1/browser_sessions")) return json({ browser_session_id: "pbs_6", app_url: null });
      if (u.endsWith("/close")) return json({ ok: true });
      if (u.endsWith("/v1/run/tasks")) return json({ run_id: "tsk_6" });
      if (u.endsWith("/v1/credentials/totp")) return json({ totp_code_id: "tc_6" });
      return json({ status: "completed", output: { outcome: "accepted", password_set: true } });
    });
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    const letter = "Confirm\nOpen https://app.acme.io/magic to continue";
    expect(await client.offerEmail(letter)).toMatchObject({ taken: false, posted: false });
    const pending = client.acceptInvite({
      runId: "run_6",
      url: "https://app.acme.io/invite/abc",
      service: "Acme",
      agentName: "Bot",
      email: "bot@agents.test",
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    const totp = calls.find((c) => c.url.endsWith("/v1/credentials/totp"))!.body as Record<string, unknown>;
    expect(totp).toEqual({
      totp_identifier: "bot@agents.test",
      task_id: "tsk_6",
      source: "Acme-inbox",
      content: letter,
    });
    expect(client.mailboxCaptured).toBe(false);
    vi.useRealTimers();
  });

  it("keeps the invite running when the TOTP post fails", async () => {
    vi.useFakeTimers();
    const { store } = fakeStore();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/browser_sessions")) return json({ browser_session_id: "pbs_7", app_url: null });
      if (u.endsWith("/close")) return json({ ok: true });
      if (u.endsWith("/v1/run/tasks")) return json({ run_id: "tsk_7" });
      if (u.endsWith("/v1/credentials/totp")) return new Response("nope", { status: 500 });
      return json({ status: "completed", output: { outcome: "accepted", password_set: true } });
    });
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    const pending = client.acceptInvite({
      runId: "run_7",
      url: "https://app.acme.io/invite/abc",
      service: "Acme",
      agentName: "Bot",
      email: "bot@agents.test",
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await client.offerEmail("Verify\n482913")).toMatchObject({ taken: true, posted: false, code: null });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toMatchObject({ status: "accepted" });
    vi.useRealTimers();
  });

  it("opens a browser session for login so the task has browser_session_id", async () => {
    vi.useFakeTimers();
    const { store } = fakeStore();
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/v1/browser_sessions")) return json({ browser_session_id: "pbs_8", app_url: null });
      if (u.endsWith("/close")) return json({ ok: true });
      if (u.endsWith("/v1/run/tasks")) return json({ run_id: "tsk_8" });
      return json({ status: "completed", output: { logged_in: true } });
    });
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    const pending = client.runLoginOrSignup({
      runId: "run_8",
      url: "https://app.acme.io/login",
      purpose: "login",
      prompt: "войди",
      credentials: { email: "bot@agents.test" },
      service: "Acme",
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    const start = calls.find((c) => c.url.endsWith("/v1/run/tasks"))!.body as Record<string, unknown>;
    expect(start.browser_session_id).toBe("pbs_8");
    expect(start.totp_identifier).toBe("bot@agents.test");
    expect(String(start.prompt)).toMatch(/не пропускай этот шаг/);
    expect(String(start.prompt)).toMatch(/forgot\/reset password/);
    expect(client.mailboxCaptured).toBe(false);
    vi.useRealTimers();
  });

  it("does not post a letter while no login task is running", async () => {
    const { store } = fakeStore();
    const fetchImpl = vi.fn();
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    expect(await client.offerEmail("Verify\n1234")).toMatchObject({ taken: false, posted: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the letter as received, without turning it into a bare code", async () => {
    vi.useFakeTimers();
    const { store } = fakeStore();
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/v1/browser_sessions")) {
        return json({ browser_session_id: "pbs_5", app_url: null, browser_address: "wss://x" });
      }
      if (u.endsWith("/close")) return json({ ok: true });
      if (u.endsWith("/v1/run/tasks")) return json({ run_id: "tsk_5" });
      if (u.endsWith("/v1/credentials/totp")) return json({ totp_code_id: "tc_5", code: "991122" });
      return json({ status: "completed", output: { outcome: "accepted", password_set: true } });
    });
    const client = new SkyvernClient("key", store, "bot@agents.test", "https://api.skyvern.test", fetchImpl as typeof fetch);
    const pending = client.acceptInvite({
      runId: "run_5",
      url: "https://app.acme.io/invite/abc",
      service: "Acme",
      agentName: "Bot",
      email: "bot@agents.test",
    });
    await vi.advanceTimersByTimeAsync(10);
    const body = "Verify\nYour Acme code is 991122. Expires in 10 minutes.\nhttps://app.acme.io/magic";
    expect(await client.offerEmail(body)).toMatchObject({ taken: true, posted: true, code: "991122" });
    const totp = calls.find((c) => c.url.endsWith("/v1/credentials/totp"))!.body as Record<string, unknown>;
    expect(totp.content).toBe(body);
    expect(totp.source).toBe("Acme-inbox");
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    vi.useRealTimers();
  });
});
