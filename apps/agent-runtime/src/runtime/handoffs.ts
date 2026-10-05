import type { PendingApproval, Run } from "@swarm/contracts";
import type { DiscoveryResult } from "../discovery";
import { mailTouchesHost } from "../connect";
import { runConnectFollowup } from "../onboarding";
import { escalationNote } from "../prompts";
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
  /** Заявка ждёт администратора сервиса, а не человека в браузере. */
  serviceWait?: boolean;
}

export type ResumeConnect = (
  rt: AgentRuntime,
  run: Run,
  ctx: HandoffContext,
) => Promise<{ status: "ready" | "needs_secret" | "escalated" | "failed" | "ignored"; mode: string | null; reason: string; liveUrl: string | null; handoffId?: string | null }>;

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

  /** После рестарта пароль и ссылка снова в памяти: они лежат на диске, не в чате. */
  async restore(): Promise<void> {
    const all = await this.rt.store.readHandoffContexts<HandoffContext>();
    for (const [id, ctx] of Object.entries(all)) this.contexts.set(id, ctx);
  }

  private async persist(): Promise<void> {
    const all: Record<string, HandoffContext> = {};
    for (const [id, ctx] of this.contexts) all[id] = ctx;
    await this.rt.store.writeHandoffContexts(all);
  }

  /** Письмо с сервиса, чья заявка ещё ждёт одобрения. */
  async matchServiceMail(email: { from: string; links: string[] }): Promise<PendingApproval | null> {
    const list = await this.rt.store.listApprovals();
    for (const pending of list) {
      const ctx = this.contexts.get(pending.id);
      if (!ctx?.serviceWait) continue;
      if (mailTouchesHost(email, ctx.url)) return pending;
    }
    return null;
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
      liveUrl: ctx.serviceWait ? null : ctx.liveUrl,
      serviceWait: Boolean(ctx.serviceWait),
    };
    this.contexts.set(pending.id, ctx);

    if (rt.cfg.ownerEmail && rt.controlPlane.enabled) {
      try {
        const { messageId } = await rt.controlPlane.sendEmail({
          to: rt.cfg.ownerEmail,
          subject: ctx.serviceWait ? `Жду одобрения регистрации: ${ctx.service}` : `Нужна помощь со входом: ${ctx.service}`,
          text: (ctx.serviceWait
            ? [
                `${rt.cfg.agentName} отправил заявку на регистрацию в ${ctx.service} с ${rt.cfg.email}.`,
                "Одобрите её в сервисе. Когда аккаунт включат, нажмите «Одобрил, продолжай» в чате. Письмо сервиса на почту агента продолжит вход само. Ответ на это письмо словом «да» делает то же самое.",
              ]
            : [
                `${rt.cfg.agentName} не смог войти в ${ctx.service} сам: ${safe}`,
                ctx.liveUrl ? `Браузер оставлен открытым, можно взять управление: ${ctx.liveUrl}` : "",
                "Когда доделаете вход, нажмите «Я доделал» в чате агента. Ответ на это письмо словом «да» делает то же самое.",
              ]
          )
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
      serviceWait: Boolean(ctx.serviceWait),
      approvalId: pending.id,
      liveUrl: ctx.serviceWait ? null : ctx.liveUrl,
      text: safe,
      runId: run.id,
      chatId,
    });
    const list = await rt.store.listApprovals();
    list.push(pending);
    await rt.store.saveApprovals(list);
    await this.persist();
    return pending;
  }

  /** Контекст может потеряться после рестарта: тогда вход повторится с ссылки приглашения. */
  async resolve(pending: PendingApproval, done: boolean, chatId: string): Promise<Run> {
    const { rt } = this;
    const ctx = this.contexts.get(pending.id) ?? null;
    this.contexts.delete(pending.id);
    await this.persist();
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
      if (result.status === "ready" || result.status === "needs_secret") {
        const mode = result.mode === "api" || result.mode === "mcp" || result.mode === "browser" ? result.mode : null;
        await runConnectFollowup(
          rt,
          run,
          chatId,
          service,
          { status: result.status, mode },
          ctx
            ? {
                url: ctx.url,
                slug: ctx.slug,
                service: ctx.service,
                discovery: ctx.discovery,
                password: ctx.password,
                provider: ctx.provider,
                browserSessionId: ctx.browserSessionId,
              }
            : null,
        );
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
