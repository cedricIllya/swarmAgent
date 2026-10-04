import type { InboundEmail } from "@swarm/contracts";
import { classifyReply, findDigitCode, matchesThread } from "./approval";
import {
  EMAIL_CLASSIFY_SCHEMA,
  classifyEmailPrompt,
  emailTaskPrompt,
  type EmailClassification,
} from "./prompts";
import type { AgentRuntime } from "./runtime";
import { recordUsage } from "./usage";
import { log, warn } from "./log";

function ownerAddress(rt: AgentRuntime): string | null {
  return rt.cfg.ownerEmail?.toLowerCase() ?? null;
}

function bareAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim().toLowerCase();
}

/**
 * Три двери в порядке:
 * 1. Ответ в ветке на письмо агента — слова «да/нет» или новая задача. Без браузера и онбординга.
 * 2. Агент сейчас в браузере — код или ссылка в ждущую сессию, письмо отложено и перечитается.
 * 3. Иначе задача: модель решает, приглашение это или просьба.
 */
export async function processEmail(rt: AgentRuntime, email: InboundEmail): Promise<void> {
  const sent = await rt.store.sentMessages();
  const threadId = matchesThread(email, Object.keys(sent));

  if (threadId) {
    await handleThreadReply(rt, email, threadId, sent[threadId]?.approvalId ?? null);
    return;
  }

  if (rt.busyInBrowser) {
    const owner = ownerAddress(rt);
    const fromOwner = owner !== null && bareAddress(email.from) === owner;
    if (!fromOwner) {
      await handleWhileInBrowser(rt, email);
      return;
    }
  }

  await handleNewEmail(rt, email);
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
    const run = await rt.resolveApproval(approvalId, verdict === "approve");
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
  const text = await rt.think(run, emailTaskPrompt(email, "task"));
  await rt.finishRun(run, "done", text);
  await replyInThread(rt, email, run.id, text);
}

async function handleWhileInBrowser(rt: AgentRuntime, email: InboundEmail): Promise<void> {
  await rt.store.deferEmail(email);

  const code = findDigitCode(`${email.subject}\n${email.replyText || email.text}`);
  if (code) {
    const delivered = rt.deliverCodeToBrowser({ kind: "code", value: code });
    log("inbox", "код из письма в браузер", { delivered });
    return;
  }

  const c = await classifyEmail(rt, email, "classify.email.in-browser");
  if (c.kind === "verification" && c.hasLoginLink && email.links.length > 0) {
    const link = email.links.find((l) => /verify|confirm|magic|login|signin|auth|token/i.test(l)) ?? email.links[0]!;
    const delivered = rt.deliverCodeToBrowser({ kind: "link", value: link });
    log("inbox", "ссылка для входа в браузер", { delivered });
    return;
  }
  log("inbox", "письмо отложено до конца работы в браузере", { subject: email.subject });
}

async function handleNewEmail(rt: AgentRuntime, email: InboundEmail): Promise<void> {
  const c = await classifyEmail(rt, email, "classify.email");
  log("inbox", "письмо классифицировано", { kind: c.kind, service: c.service });

  if (c.kind === "notification" || c.kind === "other" || c.kind === "verification") {
    const run = await rt.createRun("email", email.subject || "Письмо", email.messageId);
    await rt.step(run.id, "email", `${c.kind}: ${c.summary}`);
    await rt.finishRun(run, "done", `Без действий: ${c.summary}`);
    return;
  }

  const run = await rt.createRun("email", email.subject || (c.kind === "invite" ? "Приглашение" : "Задача"), email.messageId);
  await rt.step(run.id, "email", `${c.kind} от ${email.from}`, { service: c.service, domain: c.serviceDomain });
  try {
    const text = await rt.think(run, emailTaskPrompt(email, c.kind));
    const current = await rt.store.getRun(run.id);
    if (current?.status === "waiting_approval") return;
    await rt.finishRun(run, "done", text);
    if (c.kind === "task") await replyInThread(rt, email, run.id, text);
  } catch (e) {
    warn("inbox", "задача упала", { error: String(e) });
    await rt.step(run.id, "error", String(e));
    await rt.finishRun(run, "failed", String(e));
  }
}

async function classifyEmail(rt: AgentRuntime, email: InboundEmail, action: string): Promise<EmailClassification> {
  try {
    const r = await rt.openRouter.chat(
      [{ role: "user", content: classifyEmailPrompt(email) }],
      { jsonSchema: { name: "email_classification", schema: EMAIL_CLASSIFY_SCHEMA }, temperature: 0, maxTokens: 300 },
      rt.model,
    );
    await recordUsage(rt.store, { taskId: "inbox", taskTitle: "Разбор почты" }, action, "runtime", r);
    return JSON.parse(r.text) as EmailClassification;
  } catch (e) {
    warn("inbox", "классификация не удалась, считаем задачей", { error: String(e) });
    return { kind: "task", service: null, serviceDomain: null, summary: email.subject, hasLoginLink: false };
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
