import type { InboundEmail } from "@swarm/contracts";
import { classifyReply, findDigitCode, matchesThread } from "./approval";
import { emailInviteFallback } from "./invite-signal";
import { isTransientModelError } from "./openrouter";
import { prepareOnboarding, runConnectFollowup } from "./onboarding";
import { looksLikeServiceApprovalWait, serviceApprovalGranted } from "./connect";
import {
  EMAIL_CLASSIFY_SCHEMA,
  classifyEmailPrompt,
  emailTaskPrompt,
  escalationNote,
  type EmailClassification,
} from "./prompts";
import type { AgentRuntime } from "./runtime";
import { finishServiceThink } from "./service-work";
import { recordUsage } from "./usage";
import { log, warn } from "./log";

function ownerAddress(rt: AgentRuntime): string | null {
  return rt.cfg.ownerEmail?.toLowerCase() ?? null;
}

function bareAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim().toLowerCase();
}

/** Ящик сервиса, которому отвечать некуда: уведомление, не человек. */
export function isMachineSender(from: string): boolean {
  const local = (bareAddress(from).split("@")[0] ?? "").replace(/[._-]/g, "");
  return /noreply|donotreply|notification|mailerdaemon|notify/.test(local);
}

/**
 * Три двери в порядке:
 * 1. Ответ в ветке на письмо агента — слова «да/нет» или новая задача. Без браузера и онбординга.
 * 2. Агент сейчас в браузере — код или ссылка в ждущую сессию, письмо отложено и перечитается.
 * 3. Иначе задача: модель решает, приглашение это или просьба.
 */
let flushing = false;

/** Отложенные письма читаются, как только браузер освободился, а не на следующем тике. */
async function flushDeferred(rt: AgentRuntime): Promise<void> {
  if (flushing || rt.busyInBrowser) return;
  flushing = true;
  try {
    const emails = await rt.store.takeDeferredEmails();
    for (const email of emails) {
      if (rt.busyInBrowser) {
        await rt.store.deferEmail(email);
        continue;
      }
      await routeEmail(rt, email);
    }
  } finally {
    flushing = false;
  }
}

export async function processEmail(rt: AgentRuntime, email: InboundEmail): Promise<void> {
  await routeEmail(rt, email);
  await flushDeferred(rt);
}

async function routeEmail(rt: AgentRuntime, email: InboundEmail): Promise<void> {
  const sent = await rt.store.sentMessages();
  const threadId = matchesThread(email, Object.keys(sent));

  if (threadId) {
    await handleThreadReply(rt, email, threadId, sent[threadId]?.approvalId ?? null);
    return;
  }

  const owner = ownerAddress(rt);
  const fromOwner = owner !== null && bareAddress(email.from) === owner;

  if (rt.busyInBrowser && !fromOwner) {
    await handleWhileInBrowser(rt, email);
    return;
  }

  // Браузер открыт, но код ещё не просил (страница с полем только грузится):
  // код или ссылку придерживаем для сессии, остальная почта идёт обычным путём.
  let known: EmailClassification | null = null;
  if ((rt.browser.sessions.size > 0 || rt.skyvern?.busy) && !fromOwner) {
    if (await deliverEmailChallenge(rt, email)) {
      await rt.store.deferEmail(email);
      return;
    }
    known = await classifyEmail(rt, email, "classify.email.browser-open").catch(() => null);
    if (known?.kind === "verification" && known.hasLoginLink && email.links.length > 0) {
      const link = pickLoginLink(email.links);
      if (await rt.browser.deliverCode({ kind: "link", value: link, emailBody: emailBodyForLink(email, link) })) {
        await rt.store.deferEmail(email);
        log("inbox", "ссылка для входа отдана в браузер и письмо сохранено");
        return;
      }
    }
  }

  await handleNewEmail(rt, email, known);
}

/** Код/OTP из письма → в Skyvern или свой браузер. В Skyvern уходит тело письма целиком. */
async function deliverEmailChallenge(rt: AgentRuntime, email: InboundEmail): Promise<boolean> {
  const body = `${email.subject}\n${email.replyText || email.text}`.trim();
  const code = findDigitCode(body);
  if (!code) return false;
  const delivered = await rt.browser.deliverCode({ kind: "code", value: code, emailBody: body });
  log("inbox", delivered ? "код из письма отдан в браузер" : "код из письма некуда отдать", {
    code,
    codeLen: code.length,
    delivered,
    toSkyvern: Boolean(rt.skyvern?.busy),
  });
  return delivered;
}

function emailBodyForLink(email: InboundEmail, link: string): string {
  const body = `${email.subject}\n${email.replyText || email.text}`.trim();
  return body.includes(link) ? body : `${body}\n${link}`.trim();
}

function shouldResumeParked(email: InboundEmail, c: EmailClassification): boolean {
  const text = `${email.subject}\n${email.replyText || email.text}`;
  if (looksLikeServiceApprovalWait(text) && !serviceApprovalGranted(text)) return false;
  if (c.kind === "verification" || c.hasLoginLink) return true;
  return serviceApprovalGranted(text);
}

function pickLoginLink(links: string[]): string {
  return links.find((l) => /verify|confirm|magic|login|signin|auth|token/i.test(l)) ?? links[0]!;
}

async function handleThreadReply(
  rt: AgentRuntime,
  email: InboundEmail,
  threadId: string,
  approvalId: string | null,
): Promise<void> {
  const verdict = classifyReply(email.replyText);
  log("inbox", "ответ в ветке", { threadId, verdict, approvalId });

  if (approvalId && (verdict === "approve" || verdict === "reject")) {
    const run = await rt.approvals.resolve(approvalId, verdict === "approve");
    if (run) await replyInThread(rt, email, run.id, run.summary);
    return;
  }

  if (verdict !== "task") {
    // «да» без ожидающего вопроса — не на что отвечать.
    await rt.addChat({ role: "agent", text: `Письмо «${email.replyText}» в ветке без вопроса, пропущено.`, runId: null });
    return;
  }

  const run = await rt.createRun("email", email.subject || "Задача из письма", threadId);
  await rt.step(run.id, "email", `новая задача в ветке от ${email.from}`);
  const turn = await rt.think(run, emailTaskPrompt(email, "task"));
  const { text, status } = await finishServiceThink(rt, run, turn);
  if (status === "waiting_approval") return;
  await rt.finishRun(run, status, text);
  await replyInThread(rt, email, run.id, text);
}

async function handleWhileInBrowser(rt: AgentRuntime, email: InboundEmail): Promise<void> {
  await rt.store.deferEmail(email);

  if (await deliverEmailChallenge(rt, email)) return;

  const c = await classifyEmail(rt, email, "classify.email.in-browser").catch(() => null);
  if (c?.kind === "verification" && c.hasLoginLink && email.links.length > 0) {
    const link = pickLoginLink(email.links);
    const delivered = await rt.browser.deliverCode({ kind: "link", value: link, emailBody: emailBodyForLink(email, link) });
    log("inbox", "ссылка для входа в браузер", { delivered });
    return;
  }
  log("inbox", "письмо отложено до конца работы в браузере", { subject: email.subject });
}

const CLASSIFY_ATTEMPTS = 3;

function classifyAttempts(email: InboundEmail): number {
  const n = (email as { classifyAttempts?: unknown }).classifyAttempts;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

async function handleNewEmail(rt: AgentRuntime, email: InboundEmail, known: EmailClassification | null = null): Promise<void> {
  let c: EmailClassification;
  try {
    c = known ?? (await classifyEmail(rt, email, "classify.email"));
  } catch (e) {
    const fallback = emailInviteFallback(email.subject, email.replyText || email.text, email.links);
    if (fallback) {
      log("inbox", "модель не разобрала письмо, ссылка похожа на приглашение", {
        service: fallback.service,
        domain: fallback.serviceDomain,
      });
      c = fallback;
    } else if (isTransientModelError(e) && classifyAttempts(email) + 1 < CLASSIFY_ATTEMPTS) {
      await rt.store.deferEmail({ ...email, classifyAttempts: classifyAttempts(email) + 1 });
      log("inbox", "разбор письма отложен", { subject: email.subject, error: String(e) });
      return;
    } else {
      warn("inbox", "классификация не удалась", { error: String(e) });
      const run = await rt.createRun("email", email.subject || "Письмо", email.messageId);
      await rt.step(run.id, "error", "модель не разобрала письмо");
      await rt.finishRun(run, "escalated", "письмо не разобрано: модель не вернула ответ");
      return;
    }
  }
  log("inbox", "письмо классифицировано", { kind: c.kind, service: c.service });

  const parked = await rt.handoffs.matchServiceMail(email);
  if (parked) {
    if (shouldResumeParked(email, c)) {
      log("inbox", "письмо сервиса продолжает регистрацию", { subject: email.subject });
      await rt.approvals.resolve(parked.id, true);
    } else {
      log("inbox", "заявка всё ещё ждёт одобрения сервиса", { subject: email.subject });
    }
    return;
  }

  if (c.kind === "verification") {
    // Письмо с OTP могло прийти чуть раньше/позже окна busyInBrowser — всё равно пробуем отдать.
    // Успешная передача уже пишет сам код в журнал активной задачи (онбординг / сессия).
    const code = findDigitCode(`${email.subject}\n${email.replyText || email.text}`);
    if (code && (await rt.browser.deliverCode({ kind: "code", value: code, emailBody: `${email.subject}\n${email.replyText || email.text}` }))) return;
    if (c.hasLoginLink && email.links.length > 0) {
      const link = pickLoginLink(email.links);
      if (await rt.browser.deliverCode({ kind: "link", value: link, emailBody: emailBodyForLink(email, link) })) return;
    }
    if (rt.busyInBrowser) {
      await rt.store.deferEmail(email);
      log("inbox", "verification отложен: браузер занят, код не извлечён", { subject: email.subject });
      return;
    }
    const run = await rt.createRun("email", email.subject || "Письмо", email.messageId);
    await rt.step(run.id, "email", `verification: ${c.summary}${code ? ` (код ${code})` : ""}`);
    await rt.finishRun(run, "done", `Без действий: ${c.summary}`);
    return;
  }

  if (c.kind === "other") {
    const run = await rt.createRun("email", email.subject || "Письмо", email.messageId);
    await rt.step(run.id, "email", `${c.kind}: ${c.summary}`);
    await rt.finishRun(run, "done", `Без действий: ${c.summary}`);
    return;
  }

  const run = await rt.createRun("email", email.subject || (c.kind === "invite" ? "Приглашение" : "Задача"), email.messageId);
  await rt.step(run.id, "email", `${c.kind} от ${email.from}`, { service: c.service, domain: c.serviceDomain });
  try {
    if (c.kind === "invite") {
      const onboarding = await prepareOnboarding(rt, run, {
        service: c.service,
        domain: c.serviceDomain,
        links: email.links,
        extraHosts: email.dkimDomains,
      });
      const engine = onboarding.engine;
      if (engine.status === "ready" || engine.status === "needs_secret") {
        const service = c.service || onboarding.discovery?.service || "сервис";
        const chatId = await rt.chatIdForRun(run);
        try {
          await runConnectFollowup(rt, run, chatId, service, { status: engine.status, mode: engine.mode });
        } catch (e) {
          await rt.finishRun(run, "done", `Подключение готово (${engine.mode ?? "browser"}). Задачи не проверены: ${String(e)}`);
        }
        return;
      }
      const note = engine.status === "escalated" ? escalationNote(engine.reason, engine.liveUrl) : engine.reason;
      // Карточка с кнопками уже в чате, если открыт handoff.
      if (!engine.handoffId) await rt.addChat({ role: "agent", text: note, runId: run.id });
      await rt.finishRun(run, engine.status === "failed" ? "failed" : engine.status === "escalated" ? "escalated" : "done", note);
      return;
    }
    const turn = await rt.think(run, emailTaskPrompt(email, c.kind));
    const { text, status } = await finishServiceThink(rt, run, turn);
    if (status === "waiting_approval") return;
    await rt.finishRun(run, status, text);
    if (c.kind === "task" && !isMachineSender(email.from)) {
      await replyInThread(rt, email, run.id, text);
    } else {
      await rt.addChat({ role: "agent", text, runId: run.id });
    }
  } catch (e) {
    warn("inbox", "задача упала", { error: String(e) });
    await rt.step(run.id, "error", String(e));
    await rt.finishRun(run, "failed", String(e));
  }
}

function parseEmailClassification(text: string): EmailClassification {
  const raw = JSON.parse(text) as Partial<EmailClassification>;
  if (raw.kind !== "invite" && raw.kind !== "task" && raw.kind !== "verification" && raw.kind !== "notification" && raw.kind !== "other") {
    throw new SyntaxError("классификация без kind");
  }
  return {
    kind: raw.kind,
    service: typeof raw.service === "string" && raw.service ? raw.service : null,
    serviceDomain: typeof raw.serviceDomain === "string" && raw.serviceDomain ? raw.serviceDomain : null,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    hasLoginLink: raw.hasLoginLink === true,
  };
}

async function classifyEmail(rt: AgentRuntime, email: InboundEmail, action: string): Promise<EmailClassification> {
  try {
    const r = await rt.openRouter.chat(
      [{ role: "user", content: classifyEmailPrompt(email) }],
      { jsonSchema: { name: "email_classification", schema: EMAIL_CLASSIFY_SCHEMA }, temperature: 0, maxTokens: 300 },
      rt.model,
    );
    await recordUsage(rt.store, { taskId: "inbox", taskTitle: "Разбор почты" }, action, "runtime", r);
    return parseEmailClassification(r.text);
  } catch (e) {
    warn("inbox", "классификация не удалась", { error: String(e) });
    throw e;
  }
}

async function replyInThread(rt: AgentRuntime, email: InboundEmail, runId: string, text: string): Promise<void> {
  if (!rt.controlPlane.enabled || !text.trim()) return;
  try {
    const refs = [...email.references, ...(email.messageId ? [email.messageId] : [])].slice(-20);
    const { messageId } = await rt.controlPlane.sendEmail({
      to: email.from,
      subject: email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
      text,
      ...(email.messageId ? { inReplyTo: email.messageId } : {}),
      references: refs,
    });
    await rt.store.rememberSent(messageId, { runId, to: email.from, approvalId: null });
    await rt.step(runId, "email", `ответ отправлен ${email.from}`, { messageId });
  } catch (e) {
    warn("inbox", "ответ не отправлен", { error: String(e) });
  }
}
