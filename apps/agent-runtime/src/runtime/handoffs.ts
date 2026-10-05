import type { PendingApproval, Run } from "@swarm/contracts";
import type { DiscoveryResult } from "../discovery";
import { connectedFollowupPrompt, escalationNote } from "../prompts";
import { redactInternal } from "../redact";
import { warn } from "../log";
import { newId } from "./ids";
import type { AgentRuntime } from "./index";

/** Что нужно, чтобы продолжить онбординг после того, как человек доделал вход. Пароль — только здесь, в памяти. */
export interface HandoffContext {
  url: string;
  slug: string;
  service: string;
  discovery: DiscoveryResult | null;
  provider: "skyvern" | "browserbase";
  browserSessionId: string | null;
  /** Пароль, который браузер уже напечатал: человек должен поставить тот же. */
  password: string | null;
  liveUrl: string | null;
}

export type ResumeConnect = (
  rt: AgentRuntime,
  run: Run,
  ctx: HandoffContext,
) => Promise<{ status: "ready" | "escalated" | "failed" | "ignored"; mode: string | null; reason: string; liveUrl: string | null; handoffId?: string | null }>;

/**
 * Human in the loop для браузера: карточка с кнопками «Я доделал» и «Отменить» и ссылкой
 * на живой экран. Нажатие «я доделал» запускает новую задачу в той же сессии.
 */
export class Handoffs {
  private readonly contexts = new Map<string, HandoffContext>();
  private resume: ResumeConnect | null = null;

  constructor(private readonly rt: AgentRuntime) {}

  /** Онбординг регистрирует продолжение один раз при старте, чтобы не тянуть циклический импорт. */
  useResume(fn: ResumeConnect): void {
    this.resume = fn;
  }

  async open(run: Run, reason: string, ctx: HandoffContext): Promise<PendingApproval> {
    const { rt } = this;
    const safe = redactInternal(reason);
    const chatId = await rt.chatIdForRun(run);
    const pending: PendingApproval = {
      id: newId("hnd"),
      runId: run.id,
      createdAt: new Date().toISOString(),
      description: safe,
      emailMessageId: null,
      chatId,
      kind: "handoff",
      liveUrl: ctx.liveUrl,
    };
    this.contexts.set(pending.id, ctx);

    if (rt.cfg.ownerEmail && rt.controlPlane.enabled) {
      try {
        const { messageId } = await rt.controlPlane.sendEmail({
          to: rt.cfg.ownerEmail,
          subject: `Нужна помощь со входом: ${ctx.service}`,
          text: [
            `${rt.cfg.agentName} не смог войти в ${ctx.service} сам: ${safe}`,
            ctx.liveUrl ? `Браузер оставлен открытым, можно взять управление: ${ctx.liveUrl}` : "",
            "Когда доделаете вход, нажмите «Я доделал» в чате агента. Ответ на это письмо словом «да» делает то же самое.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
        pending.emailMessageId = messageId;
        await rt.store.rememberSent(messageId, { runId: run.id, to: rt.cfg.ownerEmail, approvalId: pending.id });
      } catch (e) {
        warn("handoff", "не удалось отправить письмо", { error: String(e) });
      }
    }

    await rt.addChat({
      role: "agent",
      kind: "approval",
      handoff: true,
      approvalId: pending.id,
      liveUrl: ctx.liveUrl,
      text: safe,
      runId: run.id,
      chatId,
    });
    const list = await rt.store.listApprovals();
    list.push(pending);
    await rt.store.saveApprovals(list);
    return pending;
  }

  /** Контекст может потеряться после рестарта: тогда вход повторится с ссылки приглашения. */
  async resolve(pending: PendingApproval, done: boolean, chatId: string): Promise<Run> {
    const { rt } = this;
    const ctx = this.contexts.get(pending.id) ?? null;
    this.contexts.delete(pending.id);
    const original = await rt.store.getRun(pending.runId);
    const service = ctx?.service ?? original?.title ?? "сервис";

    if (!done) {
      if (ctx?.provider === "skyvern" && ctx.browserSessionId) await rt.skyvern?.closeBrowserSession(ctx.browserSessionId);
      if (ctx?.provider === "browserbase" && ctx.browserSessionId) await rt.browser.close(ctx.browserSessionId);
      const run = await rt.createRun("approval", `Отменено: ${service}`, original?.threadId ?? null);
      await rt.step(run.id, "note", "человек отменил вход, браузер закрыт");
      await rt.finishRun(run, "failed", "Вход отменён человеком, браузер закрыт.");
      await rt.addChat({ role: "agent", text: "Хорошо, вход отменён, браузер закрыт.", runId: run.id, chatId });
      return run;
    }

    const run = await rt.createRun("approval", `Продолжение: ${service}`, original?.threadId ?? null);
    if (!ctx) {
      await rt.step(run.id, "error", "контекст входа потерян (процесс перезапускался)");
      await rt.finishRun(run, "failed", "Контекст входа потерян. Пришлите приглашение ещё раз.");
      await rt.addChat({ role: "agent", text: "Контекст входа потерян после перезапуска. Пришлите приглашение ещё раз.", runId: run.id, chatId });
      return run;
    }
    if (!this.resume) throw new Error("продолжение онбординга не зарегистрировано");
    await rt.step(run.id, "note", "человек доделал вход, продолжаю в той же сессии");
    try {
      const result = await this.resume(rt, run, ctx);
      if (result.handoffId) {
        await rt.finishRun(run, "escalated", result.reason);
        return run;
      }
      if (result.status === "ready") {
        // Как и после обычного приглашения: доступ записан, агент смотрит задачи в сервисе.
        const text = await rt.think(run, connectedFollowupPrompt(service, result.mode ?? "browser"));
        const current = await rt.store.getRun(run.id);
        if (current?.status === "waiting_approval") return run;
        await rt.finishRun(run, "done", text);
        await rt.addChat({ role: "agent", text, runId: run.id, chatId });
        return run;
      }
      const text = result.status === "escalated" ? escalationNote(result.reason, result.liveUrl) : result.reason;
      await rt.finishRun(run, result.status === "escalated" ? "escalated" : "failed", text);
      await rt.addChat({ role: "agent", text, runId: run.id, chatId });
    } catch (e) {
      warn("handoff", "продолжение упало", { error: String(e) });
      await rt.step(run.id, "error", String(e));
      await rt.finishRun(run, "failed", String(e));
      await rt.addChat({ role: "agent", text: redactInternal(`Не получилось продолжить: ${String(e)}`), runId: run.id, chatId });
    }
    return run;
  }
}
