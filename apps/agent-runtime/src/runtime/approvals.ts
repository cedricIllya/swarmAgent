import type { PendingApproval, Run } from "@swarm/contracts";
import { approvalContinuationPrompt } from "../prompts";
import { redactInternal } from "../redact";
import { warn } from "../log";
import { newId } from "./ids";
import type { AgentRuntime } from "./index";

/**
 * Одобрение человеком: вопрос уходит письмом владельцу и карточкой в чат,
 * задача замирает в `waiting_approval`, а решение возвращает её модели.
 */
export class Approvals {
  constructor(private readonly rt: AgentRuntime) {}

  async request(runId: string, description: string): Promise<{ approved: boolean; pending: PendingApproval | null }> {
    const { rt } = this;
    const safe = redactInternal(description);
    if (rt.autonomous) {
      await rt.step(runId, "note", `автономно: ${safe}`);
      return { approved: true, pending: null };
    }
    const run = await rt.store.getRun(runId);
    if (!run) throw new Error("run не найден");

    const chatId = await rt.chatIdForRun(run);
    const pending: PendingApproval = {
      id: newId("apr"),
      runId,
      createdAt: new Date().toISOString(),
      description: safe,
      emailMessageId: null,
      chatId,
    };

    if (rt.cfg.ownerEmail && rt.controlPlane.enabled) {
      try {
        const { messageId } = await rt.controlPlane.sendEmail({
          to: rt.cfg.ownerEmail,
          subject: `Нужно одобрение: ${run.title}`,
          text: `${rt.cfg.agentName} хочет:\n\n${safe}\n\nВ чате есть кнопки «Да» и «Нет». Можно ответить на это письмо одним словом: «да» или «нет». Любой другой текст станет новой задачей.`,
          ...(run.threadId ? { inReplyTo: run.threadId, references: [run.threadId] } : {}),
        });
        pending.emailMessageId = messageId;
        await rt.store.rememberSent(messageId, { runId, to: rt.cfg.ownerEmail, approvalId: pending.id });
        await rt.step(runId, "email", `письмо с вопросом владельцу`, { messageId });
      } catch (e) {
        warn("approval", "не удалось отправить письмо", { error: String(e) });
      }
    }

    await rt.addChat({
      role: "agent",
      kind: "approval",
      approvalId: pending.id,
      text: safe,
      runId,
      chatId,
    });
    const list = await rt.store.listApprovals();
    list.push(pending);
    await rt.store.saveApprovals(list);
    await rt.finishRun(run, "waiting_approval", `Ждёт одобрения: ${safe}`);
    return { approved: false, pending };
  }

  async resolve(approvalId: string, approved: boolean, opts?: { announce?: boolean }): Promise<Run | null> {
    const { rt } = this;
    const list = await rt.store.listApprovals();
    const pending = list.find((p) => p.id === approvalId);
    if (!pending) return null;
    await rt.store.saveApprovals(list.filter((p) => p.id !== approvalId));
    const run = await rt.store.getRun(pending.runId);
    if (!run) return null;
    const chatId = pending.chatId ?? (await rt.store.chats.ensureSystem()).id;
    if (opts?.announce !== false) {
      await rt.addChat({
        role: "user",
        kind: "approval",
        approvalId,
        decision: approved ? "approved" : "rejected",
        text: approved ? "Да" : "Нет",
        runId: run.id,
        chatId,
      });
    }
    run.status = "running";
    await rt.store.saveRun(run);
    await rt.step(run.id, "note", approved ? "одобрено человеком" : "отклонено человеком");
    const text = await rt.think(run, approvalContinuationPrompt(pending.description, approved), "hermes.approval");
    await rt.finishRun(run, "done", text);
    await rt.addChat({ role: "agent", text, runId: run.id, chatId });
    return run;
  }

  /** Самое старое ожидание в ветке письма — то, на которое отвечают «да». */
  async forThread(threadMessageId: string): Promise<PendingApproval | null> {
    const list = await this.rt.store.listApprovals();
    return list.find((p) => p.emailMessageId === threadMessageId) ?? null;
  }
}
