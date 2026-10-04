import type { Run } from "@swarm/contracts";
import {
  CHAT_CLASSIFY_SCHEMA,
  chatTaskPrompt,
  chatTitle,
  classifyChatPrompt,
  extractLinks,
  runTitle,
  type ChatClassification,
} from "./prompts";
import type { AgentRuntime } from "./runtime";
import { hostOf } from "./domains";
import { prepareOnboarding } from "./onboarding";
import { warn } from "./log";
import { redactInternal } from "./redact";
import { recordUsage } from "./usage";

const TASK: ChatClassification = { kind: "task", service: null, serviceDomain: null };

async function classifyChat(rt: AgentRuntime, message: string, links: string[]): Promise<ChatClassification> {
  try {
    const r = await rt.openRouter.chat(
      [{ role: "user", content: classifyChatPrompt(message, links) }],
      { jsonSchema: { name: "chat_classification", schema: CHAT_CLASSIFY_SCHEMA }, temperature: 0, maxTokens: 200 },
      rt.model,
    );
    await recordUsage(rt.store, { taskId: "chat", taskTitle: "Разбор чата" }, "classify.chat", "runtime", r);
    return JSON.parse(r.text) as ChatClassification;
  } catch (e) {
    warn("chat", "классификация не удалась, считаем задачей", { error: String(e) });
    return TASK;
  }
}

/** Чат на карточке: отдельная история и сессия Hermes на каждый чат. */
export async function handleChat(
  rt: AgentRuntime,
  args: { chatId?: string | undefined; message: string; author: string },
): Promise<{ run: Run; chatId: string } | null> {
  const links = extractLinks(args.message);
  const classification = await classifyChat(rt, args.message, links);
  const hosts = [...links.map(hostOf), classification.serviceDomain ?? ""].filter(Boolean);
  const recipe = classification.kind === "invite" ? null : await rt.knownRecipe(hosts);

  let chatId = args.chatId ?? null;
  if (chatId) {
    const existing = await rt.store.getChat(chatId);
    if (!existing) return null;
  } else {
    const created = await rt.store.createChat(chatTitle(classification.kind, classification.service, args.message));
    chatId = created.id;
  }

  const run = await rt.createRun("chat", runTitle(classification.kind, classification.service, args.message), chatId);
  await rt.step(run.id, "note", `чат: ${classification.kind}${classification.service ? `, ${classification.service}` : ""}`);
  await rt.addChat({ role: "user", text: args.message, runId: run.id, chatId });

  const knownRecipe = recipe ? { slug: recipe.slug, name: recipe.name, kind: recipe.kind } : null;

  void (async () => {
    try {
      // Приглашение: рецепт или поиск документации, затем принять приглашение под своей почтой —
      // и только потом ход модели.
      const onboarding =
        classification.kind === "invite"
          ? await prepareOnboarding(rt, run, { service: classification.service, domain: classification.serviceDomain, links })
          : undefined;
      const prompt = chatTaskPrompt({
        message: args.message,
        author: args.author,
        kind: classification.kind,
        links,
        recipe: onboarding?.recipe ?? knownRecipe,
        onboarding,
      });
      const text = await rt.think(run, prompt);
      const current = await rt.store.getRun(run.id);
      if (current?.status === "waiting_approval") return;
      await rt.finishRun(run, "done", text);
      await rt.addChat({ role: "agent", text, runId: run.id, chatId });
    } catch (e) {
      warn("chat", "задача упала", { error: String(e) });
      await rt.step(run.id, "error", String(e));
      await rt.finishRun(run, "failed", String(e));
      await rt.addChat({ role: "agent", text: redactInternal(`Не получилось: ${String(e)}`), runId: run.id, chatId });
    }
  })();

  return { run, chatId };
}
