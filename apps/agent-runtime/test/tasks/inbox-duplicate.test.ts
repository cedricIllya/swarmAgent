import { describe, expect, it, vi } from "vitest";
import type { InboundEmail, Run, RunStep } from "@swarm/contracts";
import { processEmail } from "../../src/tasks/inbox";
import type { AgentRuntime } from "../../src/runtime";

function email(): InboundEmail {
  return {
    sender: "noreply@linear.app",
    from: "Linear <noreply@linear.app>",
    to: "agent@example.com",
    subject: "Назначили LIN-12",
    text: "Вам назначена задача LIN-12",
    html: "",
    headers: {},
    messageId: "<m1@linear.app>",
    inReplyTo: null,
    references: [],
    dkimDomains: ["linear.app"],
    replyText: "Вам назначена задача LIN-12",
    links: ["https://linear.app/acme/issue/LIN-12/fix-the-bug"],
    spf: "pass",
    dkim: "pass",
    receivedAt: "2026-10-07T12:00:00.000Z",
  };
}

describe("processEmail", () => {
  it("does not start a second run when cron already took the same ticket", async () => {
    const open = {
      id: "run_cron",
      title: "linear: Починить баг",
      threadId: null,
      status: "running",
      trigger: "cron",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      summary: "",
    } as Run;
    const steps = new Map<string, RunStep[]>([
      ["run_cron", [{ at: "t", kind: "note", text: "linear: LIN-12, назначена на меня" }]],
    ]);
    const createRun = vi.fn();
    const step = vi.fn(async (id: string, kind: RunStep["kind"], text: string) => {
      const list = steps.get(id) ?? [];
      list.push({ at: "t2", kind, text });
      steps.set(id, list);
    });
    const think = vi.fn();
    const rt = {
      cfg: { ownerEmail: null },
      skyvern: null,
      browser: { waitingForCode: false, sessions: new Map() },
      handoffs: { matchServiceMail: async () => null },
      isCanceled: async () => false,
      openRouter: {
        chat: async () => ({
          text: JSON.stringify({
            kind: "notification",
            service: "Linear",
            serviceDomain: "linear.app",
            summary: "назначили LIN-12",
            hasLoginLink: false,
          }),
          model: "m",
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
        }),
      },
      store: {
        sentMessages: async () => ({}),
        takeDeferredEmails: async () => [],
        addUsage: async () => undefined,
        listRuns: async () => [open],
        getRun: async (id: string) => (id === open.id ? open : null),
        listSteps: async (id: string) => steps.get(id) ?? [],
      },
      createRun,
      step,
      think,
    } as unknown as AgentRuntime;

    await processEmail(rt, email());

    expect(createRun).not.toHaveBeenCalled();
    expect(think).not.toHaveBeenCalled();
    expect(steps.get("run_cron")?.some((item) => item.text.includes("второй раз не начинаю"))).toBe(true);
  });
});
