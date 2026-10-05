import { describe, expect, it, vi } from "vitest";
import type { PendingApproval, Run } from "@swarm/contracts";
import { Handoffs, type HandoffContext, type ResumeConnect } from "./handoffs";
import type { AgentRuntime } from "./index";

function fakeRuntime() {
  const approvals: PendingApproval[] = [];
  const chat: Array<Record<string, unknown>> = [];
  const runs = new Map<string, Run>();
  let n = 0;
  const rt = {
    cfg: { ownerEmail: null, agentName: "Бот" },
    controlPlane: { enabled: false, sendEmail: vi.fn() },
    skyvern: { closeBrowserSession: vi.fn(async () => undefined) },
    browser: { close: vi.fn(async () => undefined) },
    store: {
      listApprovals: async () => [...approvals],
      saveApprovals: async (list: PendingApproval[]) => {
        approvals.splice(0, approvals.length, ...list);
      },
      getRun: async (id: string) => runs.get(id) ?? null,
      rememberSent: vi.fn(),
      readHandoffContexts: async () => ({}),
      writeHandoffContexts: vi.fn(async () => undefined),
    },
    chatIdForRun: async () => "chat-1",
    addChat: async (m: Record<string, unknown>) => {
      chat.push(m);
    },
    createRun: async (trigger: string, title: string) => {
      const run = { id: `run-${++n}`, trigger, title, status: "running", startedAt: "", finishedAt: null, summary: "", threadId: null } as unknown as Run;
      runs.set(run.id, run);
      return run;
    },
    step: vi.fn(async () => undefined),
    finishRun: async (run: Run, status: string, summary: string) => {
      Object.assign(run, { status, summary });
    },
    think: vi.fn(async () => "задач нет"),
  };
  return { rt: rt as unknown as AgentRuntime, approvals, chat, raw: rt };
}

const ctx: HandoffContext = {
  url: "https://app.example.com/invite/abc",
  slug: "example",
  service: "Example",
  discovery: null,
  provider: "skyvern",
  browserSessionId: "pbs_1",
  password: "Secret-123",
  liveUrl: "https://app.skyvern.com/browser-session/pbs_1",
};

describe("Handoffs", () => {
  it("opens a card with buttons and live link, keeping the password out of chat and approvals", async () => {
    const { rt, approvals, chat } = fakeRuntime();
    const handoffs = new Handoffs(rt);
    const run = await rt.createRun("email", "Example", null);
    const pending = await handoffs.open(run, "Капча не прошла.", ctx);

    expect(pending.kind).toBe("handoff");
    expect(pending.liveUrl).toBe(ctx.liveUrl);
    expect(approvals).toHaveLength(1);
    expect(chat[0]).toMatchObject({ kind: "approval", handoff: true, approvalId: pending.id, liveUrl: ctx.liveUrl });
    expect(JSON.stringify(chat) + JSON.stringify(approvals)).not.toContain("Secret-123");
  });

  it("closes the browser on cancel", async () => {
    const { rt, raw } = fakeRuntime();
    const handoffs = new Handoffs(rt);
    const run = await rt.createRun("email", "Example", null);
    const pending = await handoffs.open(run, "Капча.", ctx);
    const result = await handoffs.resolve(pending, false, "chat-1");
    expect(raw.skyvern.closeBrowserSession).toHaveBeenCalledWith("pbs_1");
    expect(result.status).toBe("failed");
  });

  it("resumes in the same session with the same password and asks the agent for tasks when ready", async () => {
    const { rt, raw, chat } = fakeRuntime();
    const handoffs = new Handoffs(rt);
    const resume = vi.fn<ResumeConnect>(async () => ({ status: "ready", mode: "api", reason: "ok", liveUrl: null, handoffId: null }));
    handoffs.useResume(resume);
    const run = await rt.createRun("email", "Example", null);
    const pending = await handoffs.open(run, "Капча.", ctx);
    const result = await handoffs.resolve(pending, true, "chat-1");

    expect(resume).toHaveBeenCalledTimes(1);
    const passed = resume.mock.calls[0]![2];
    expect(passed.browserSessionId).toBe("pbs_1");
    expect(passed.password).toBe("Secret-123");
    expect(raw.think).toHaveBeenCalled();
    expect(result.status).toBe("done");
    expect(chat.at(-1)).toMatchObject({ text: "задач нет" });
  });

  it("fails honestly when the context is gone", async () => {
    const { rt } = fakeRuntime();
    const handoffs = new Handoffs(rt);
    handoffs.useResume(vi.fn());
    const orphan: PendingApproval = { id: "hnd_x", runId: "run-0", createdAt: "", description: "", emailMessageId: null, chatId: "chat-1", kind: "handoff", liveUrl: null };
    const result = await handoffs.resolve(orphan, true, "chat-1");
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Контекст входа потерян");
  });
});
