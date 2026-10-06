import type { PendingApproval, Run } from "@swarm/contracts";
import { approvalContinuationPrompt, questionContinuationPrompt } from "../prompts";
import { redactInternal } from "../redact";
import { finishServiceThink } from "../service-work";
import { warn } from "../log";
import { newId } from "./ids";
import type { AgentRuntime } from "./index";

/** Карточка снята и ответ человека записан. Ход модели ещё впереди. */
interface AcceptedReply {
  pending: PendingApproval;
  run: Run;
  chatId: string;
  question: boolean;
  handoff: boolean;
  answer: string;
}

/**
 * Одобрение человеком: вопрос уходит письмом владельцу и карточкой в чат,
 * задача замирает в `waiting_approval`, а решение возвращает её модели.
 */
export class Approvals {
  /** Решение уже принято: повторный клик не запускает второй ход. */
  private readonly inflight = new Set<string>();

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

  /**
   * Вопрос владельцу: кнопки вариантов и поле ответа в журнале задачи.
   * Автономный режим это не пропускает — без данных человека ход невозможен.
   * Повторный вызов в той же задаче не плодит вторую карточку.
   */
  async ask(runId: string, question: string, options: string[]): Promise<{ pendingId: string }> {
    const { rt } = this;
    const safe = redactInternal(question).slice(0, 2000);
    const choices = [...new Set(options.map((o) => redactInternal(o).replace(/\s+/g, " ").trim()).filter((o) => o.length >= 2))].slice(0, 6);
    const run = await rt.store.getRun(runId);
    if (!run) throw new Error("run не найден");

    const list = await rt.store.listApprovals();
    const existing = list.find((p) => p.runId === runId && p.kind === "question");
    if (existing) return { pendingId: existing.id };

    const chatId = await rt.chatIdForRun(run);
    const pending: PendingApproval = {
      id: newId("qst"),
      runId,
      createdAt: new Date().toISOString(),
      description: safe,
      emailMessageId: null,
      chatId,
      kind: "question",
      options: choices,
    };

    if (rt.cfg.ownerEmail && rt.controlPlane.enabled) {
      try {
        const lines = [
          `${rt.cfg.agentName} спрашивает:`,
          "",
          safe,
          "",
          ...choices.map((o, i) => `${i + 1}. ${o}`),
          "",
          "Ответьте в журнале задачи: там кнопки и поле. Ответ на это письмо станет ответом на вопрос, а не новой задачей.",
        ];
        const { messageId } = await rt.controlPlane.sendEmail({
          to: rt.cfg.ownerEmail,
          subject: `Нужен ответ: ${run.title}`,
          text: lines.filter((l) => l !== undefined).join("\n"),
          ...(run.threadId ? { inReplyTo: run.threadId, references: [run.threadId] } : {}),
        });
        pending.emailMessageId = messageId;
        await rt.store.rememberSent(messageId, { runId, to: rt.cfg.ownerEmail, approvalId: pending.id });
        await rt.step(runId, "email", "письмо с вопросом владельцу", { messageId });
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
      ...(choices.length ? { options: choices } : {}),
    });
    list.push(pending);
    await rt.store.saveApprovals(list);
    await rt.step(runId, "note", "жду ответ в журнале задачи");
    await rt.finishRun(run, "waiting_approval", `Ждёт ответа: ${safe}`);
    return { pendingId: pending.id };
  }

  async resolve(approvalId: string, approved: boolean, opts?: { announce?: boolean; answer?: string }): Promise<Run | null> {
    const accepted = await this.accept(approvalId, approved, opts);
    if (!accepted) return null;
    return this.continueAfter(accepted, approved);
  }

  /**
   * Снять карточку и записать ответ. Ход модели сюда не входит:
   * журнал может ответить человеку, не дожидаясь продолжения.
   */
  async accept(approvalId: string, approved: boolean, opts?: { announce?: boolean; answer?: string }): Promise<AcceptedReply | null> {
    if (this.inflight.has(approvalId)) return null;
    this.inflight.add(approvalId);
    const { rt } = this;
    try {
      const list = await rt.store.listApprovals();
      const pending = list.find((p) => p.id === approvalId);
      const question = pending?.kind === "question";
      const answer = opts?.answer?.trim() ?? "";
      if (!pending || (question && !answer)) {
        this.inflight.delete(approvalId);
        return null;
      }
      await rt.store.saveApprovals(list.filter((p) => p.id !== approvalId));
      const run = await rt.store.getRun(pending.runId);
      if (!run) {
        this.inflight.delete(approvalId);
        return null;
      }
      const chatId = pending.chatId ?? (await rt.store.chats.ensureSystem()).id;
      const handoff = pending.kind === "handoff";
      if (opts?.announce !== false) {
        await rt.addChat({
          role: "user",
          kind: "approval",
          approvalId,
          handoff,
          ...(question ? {} : { decision: approved ? ("approved" as const) : ("rejected" as const) }),
          text: question ? answer : handoff ? (approved ? "Я доделал" : "Отменить") : approved ? "Да" : "Нет",
          runId: run.id,
          chatId,
        });
      }
      return { pending, run, chatId, question: Boolean(question), handoff, answer };
    } catch (e) {
      this.inflight.delete(approvalId);
      throw e;
    }
  }

  /** Продолжить задачу после уже записанного ответа. Ошибка хода не отменяет сам ответ. */
  async continueAfter(accepted: AcceptedReply, approved: boolean): Promise<Run> {
    const { rt } = this;
    const { pending, run, chatId, question, handoff, answer } = accepted;
    try {
      if (handoff) return await rt.handoffs.resolve(pending, approved, chatId);
      if (await rt.isCanceled(run.id)) return run;
      run.status = "running";
      await rt.store.saveRun(run);
      await rt.step(run.id, "note", question ? "ответ человека получен" : approved ? "одобрено человеком" : "отклонено человеком");
      try {
        const turn = await rt.think(
          run,
          question ? questionContinuationPrompt(pending.description, answer) : approvalContinuationPrompt(pending.description, approved),
          question ? "hermes.question" : "hermes.approval",
        );
        // Отказ — делать в сервисе нечего; одобрение и ответ на вопрос — нужна реальная работа.
        const { text, status } =
          question || approved
            ? await finishServiceThink(rt, run, turn, { allowIdle: false })
            : { text: turn.text, status: "done" as const };
        if (await rt.isCanceled(run.id)) return run;
        if (status !== "waiting_approval") {
          await rt.finishRun(run, status, text);
          await rt.addChat({ role: "agent", text, runId: run.id, chatId });
        }
      } catch (e) {
        if (await rt.isCanceled(run.id)) return run;
        warn("approval", "продолжение упало", { error: String(e) });
        await rt.step(run.id, "error", String(e));
        await rt.finishRun(run, "failed", String(e));
        await rt.addChat({ role: "agent", text: redactInternal(`Не получилось: ${String(e)}`), runId: run.id, chatId });
      }
      return run;
    } finally {
      this.inflight.delete(pending.id);
    }
  }

  /** Самое старое ожидание в ветке письма — то, на которое отвечают «да». */
  async forThread(threadMessageId: string): Promise<PendingApproval | null> {
    const list = await this.rt.store.listApprovals();
    return list.find((p) => p.emailMessageId === threadMessageId) ?? null;
  }
}
