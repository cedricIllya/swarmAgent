import type { ChatMessage, Run } from "@swarm/contracts";
import { classifyReply } from "./approval";
import {
  CHAT_CLASSIFY_SCHEMA,
  chatTaskPrompt,
  chatTitle,
  classifyChatPrompt,
  escalationNote,
  extractLinks,
  runTitle,
  type ChatClassification,
} from "./prompts";
import type { AgentRuntime } from "./runtime";
import { hostOf } from "./domains";
import { coerceChatClassification } from "./invite-signal";
import { prepareOnboarding, runConnectFollowup } from "./onboarding";
import { log, warn } from "./log";
import { redactInternal } from "./redact";
import { finishServiceThink } from "./service-work";
import { recordUsage } from "./usage";

/**
 * Текст, с которого задача началась. Повтор не пишет второе сообщение человека,
 * поэтому у новой задачи своего пузыря нет — берём ближайшее предыдущее.
 */
export function chatRetrySource(messages: ChatMessage[], runId: string): string | null {
  const own = messages.filter((m) => m.runId === runId && m.role === "user" && (!m.kind || m.kind === "text"));
  const direct = own.at(-1)?.text.trim();
  if (direct) return direct;
  const idx = messages.findIndex((m) => m.runId === runId);
  if (idx < 0) return null;
  for (let i = idx; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user" || (m.kind && m.kind !== "text")) continue;
    const text = m.text.trim();
    if (text) return text;
  }
  return null;
}

function parseChatClassification(text: string): ChatClassification {
  const raw = JSON.parse(text) as Partial<ChatClassification>;
  if (raw.kind !== "invite" && raw.kind !== "credential" && raw.kind !== "task") {
    throw new SyntaxError("классификация без kind");
  }
  return {
    kind: raw.kind,
    service: typeof raw.service === "string" && raw.service ? raw.service : null,
    serviceDomain: typeof raw.serviceDomain === "string" && raw.serviceDomain ? raw.serviceDomain : null,
  };
}

async function classifyChat(rt: AgentRuntime, message: string, links: string[]): Promise<ChatClassification> {
  let parsed: ChatClassification | null = null;
  try {
    const r = await rt.openRouter.chat(
      [{ role: "user", content: classifyChatPrompt(message, links) }],
      { jsonSchema: { name: "chat_classification", schema: CHAT_CLASSIFY_SCHEMA }, temperature: 0, maxTokens: 200 },
      rt.model,
    );
    await recordUsage(rt.store, { taskId: "chat", taskTitle: "Разбор чата" }, "classify.chat", "runtime", r);
    parsed = parseChatClassification(r.text);
  } catch (e) {
    warn("chat", "классификация не удалась", { error: String(e) });
  }
  const result = coerceChatClassification(parsed, message, links);
  if (result.kind === "invite" && parsed?.kind !== "invite") {
    log("chat", "сообщение похоже на приглашение, запускаю онбординг", { service: result.service });
  }
  return result;
}

/** Чат на карточке: отдельная история и сессия Hermes на каждый чат. */
export async function handleChat(
  rt: AgentRuntime,
  args: { chatId?: string | undefined; message: string; author: string },
): Promise<{ run: Run; chatId: string } | null> {
  if (args.chatId) {
    const verdict = classifyReply(args.message);
    if (verdict === "approve" || verdict === "reject") {
      const pending = (await rt.store.listApprovals())
        .filter((p) => p.chatId === args.chatId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (pending) {
        const run = await rt.store.getRun(pending.runId);
        if (!run) return null;
        await rt.addChat({ role: "user", text: args.message, runId: run.id, chatId: args.chatId });
        void rt.approvals.resolve(pending.id, verdict === "approve", { announce: false }).catch((e) => {
          warn("chat", "одобрение не разобралось", { error: String(e) });
        });
        return { run, chatId: args.chatId };
      }
    }
  }

  const links = extractLinks(args.message);
  const classification = await classifyChat(rt, args.message, links);
  const hosts = [...links.map(hostOf), classification.serviceDomain ?? ""].filter(Boolean);
  const recipe = classification.kind === "invite" ? null : await rt.services.knownRecipe(hosts);

  let chatId = args.chatId ?? null;
  if (chatId) {
    const existing = await rt.store.chats.get(chatId);
    if (!existing) return null;
  } else {
    const created = await rt.store.chats.create(chatTitle(classification.kind, classification.service, args.message));
    chatId = created.id;
  }

  const run = await rt.createRun("chat", runTitle(classification.kind, classification.service, args.message), chatId);
  await rt.step(run.id, "note", `чат: ${classification.kind}${classification.service ? `, ${classification.service}` : ""}`);
  await rt.addChat({ role: "user", text: args.message, runId: run.id, chatId });

  const knownRecipe = recipe ? { slug: recipe.slug, name: recipe.name, kind: recipe.kind } : null;
  startChatTask(rt, {
    run,
    chatId,
    message: args.message,
    author: args.author,
    links,
    classification,
    recipe: knownRecipe,
  });
  return { run, chatId };
}

/** Повтор упавшей задачи чата: тот же текст, новая задача, без второго сообщения человека. */
export async function retryChatRun(
  rt: AgentRuntime,
  args: { chatId: string; runId: string; author: string },
): Promise<{ run: Run; chatId: string } | { error: "not_found" | "busy" }> {
  const chat = await rt.store.chats.get(args.chatId);
  const prior = await rt.store.getRun(args.runId);
  if (!chat || !prior || prior.trigger !== "chat" || prior.threadId !== args.chatId || (prior.status !== "failed" && prior.status !== "canceled")) {
    return { error: "not_found" };
  }
  const running = (await rt.store.listRuns(200)).some(
    (r) => r.threadId === args.chatId && (r.status === "running" || r.status === "queued"),
  );
  if (running) return { error: "busy" };

  const message = chatRetrySource(await rt.store.chats.listMessages(args.chatId, 1000), args.runId);
  if (!message) return { error: "not_found" };

  const links = extractLinks(message);
  const classification = await classifyChat(rt, message, links);
  const hosts = [...links.map(hostOf), classification.serviceDomain ?? ""].filter(Boolean);
  const recipe = classification.kind === "invite" ? null : await rt.services.knownRecipe(hosts);
  const run = await rt.createRun("chat", runTitle(classification.kind, classification.service, message), args.chatId);
  await rt.step(run.id, "note", "Повторяю задачу.");
  startChatTask(rt, {
    run,
    chatId: args.chatId,
    message,
    author: args.author,
    links,
    classification,
    recipe: recipe ? { slug: recipe.slug, name: recipe.name, kind: recipe.kind } : null,
  });
  return { run, chatId: args.chatId };
}

function startChatTask(
  rt: AgentRuntime,
  task: {
    run: Run;
    chatId: string;
    message: string;
    author: string;
    links: string[];
    classification: ChatClassification;
    recipe: { slug: string; name: string; kind: string } | null;
  },
): void {
  const { run, chatId, classification, links } = task;
  void (async () => {
    try {
      // Приглашение: рецепт или поиск документации, затем принять приглашение под своей почтой —
      // и только потом ход модели.
      if (classification.kind === "invite") {
        const onboarding = await prepareOnboarding(rt, run, {
          service: classification.service,
          domain: classification.serviceDomain,
          links,
        });
        if (await rt.isCanceled(run.id)) return;
        const engine = onboarding.engine;
        if (engine.status === "ready" || engine.status === "needs_secret") {
          const service = classification.service || onboarding.discovery?.service || "сервис";
          try {
            await runConnectFollowup(rt, run, chatId, service, { status: engine.status, mode: engine.mode, ...(engine.secret ? { secret: engine.secret } : {}) });
          } catch (e) {
            if (await rt.isCanceled(run.id)) return;
            const note = `Подключение готово (${engine.mode ?? "browser"}). Задачи не проверены: ${String(e)}`;
            await rt.finishRun(run, "done", note);
            await rt.addChat({ role: "agent", text: note, runId: run.id, chatId });
          }
          return;
        }
        const note = engine.status === "escalated" ? escalationNote(engine.reason, engine.liveUrl) : engine.reason;
        await rt.finishRun(run, engine.status === "failed" ? "failed" : engine.status === "escalated" ? "escalated" : "done", note);
        if (!engine.handoffId) await rt.addChat({ role: "agent", text: note, runId: run.id, chatId });
        return;
      }
      const prompt = chatTaskPrompt({
        message: task.message,
        author: task.author,
        kind: classification.kind,
        links,
        recipe: task.recipe,
      });
      const turn = await rt.think(run, prompt);
      const { text, status } = await finishServiceThink(rt, run, turn, {
        allowIdle: classification.kind !== "credential",
      });
      if (await rt.isCanceled(run.id)) return;
      if (status === "waiting_approval") return;
      await rt.finishRun(run, status, text);
      await rt.addChat({ role: "agent", text, runId: run.id, chatId });
    } catch (e) {
      if (await rt.isCanceled(run.id)) return;
      warn("chat", "задача упала", { error: String(e) });
      await rt.step(run.id, "error", String(e));
      await rt.finishRun(run, "failed", String(e));
      await rt.addChat({ role: "agent", text: redactInternal(`Не получилось: ${String(e)}`), runId: run.id, chatId });
    }
  })();
}
