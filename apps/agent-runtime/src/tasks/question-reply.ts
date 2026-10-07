import { parseUserQuestion, type Run } from "@swarm/contracts";
import { escalationContinuationPrompt, followupContinuationPrompt, questionContinuationPrompt } from "../llm/prompts";
import { redactInternal } from "../core/redact";
import { beginWork } from "../core/spent";
import { warn } from "../core/log";
import type { AgentRuntime } from "../runtime";
import { finishServiceThink } from "./service-work";

/** Вопрос уже снят с карточки, ход модели ещё впереди. */
export interface TakenQuestion {
  run: Run;
  /** Нумерованный вопрос, причина остановки или прошлый итог. */
  question: string;
  kind: "question" | "escalation" | "followup";
  chatId: string;
  answer: string;
}

const inflight = new Set<string>();

const CLOSED: ReadonlySet<Run["status"]> = new Set(["done", "failed", "canceled", "escalated"]);

/**
 * Задача уже закрыта. Человек отвечает на вопрос, пишет, что сделал, или даёт
 * новое указание, если прошлый ход не удался. У письма threadId — Message-ID,
 * не чат, поэтому ответ нельзя слать в /chat.
 */
export async function takeFinishedAnswer(rt: AgentRuntime, runId: string, answer: string): Promise<TakenQuestion | null> {
  const text = answer.trim();
  if (!text || inflight.has(runId)) return null;
  const run = await rt.store.getRun(runId);
  if (!run || !CLOSED.has(run.status)) return null;
  const question = parseUserQuestion(run.summary);
  // Пока висит карточка «Я доделал» / «Отменить», продолжение идёт через неё, а не через текст.
  if (!question && (await rt.store.listApprovals()).some((p) => p.runId === runId)) return null;
  if (await threadBusy(rt, run)) return null;
  const kind: TakenQuestion["kind"] = question ? "question" : run.status === "escalated" ? "escalation" : "followup";
  const prompt = question?.prompt ?? (run.summary.trim() || run.title);

  inflight.add(runId);
  try {
    beginWork(run);
    run.status = "running";
    run.finishedAt = null;
    run.summary = "";
    await rt.store.saveRun(run);
    const chatId = await rt.chatIdForRun(run);
    await rt.addChat({ role: "user", text, runId: run.id, chatId });
    await rt.step(run.id, "note", kind === "followup" ? "новое указание получено" : "ответ человека получен");
    return { run, question: prompt, kind, chatId, answer: text };
  } catch (e) {
    inflight.delete(runId);
    throw e;
  }
}

/** В той же ветке уже идёт другая задача — новое указание подождёт, пока она закончится. */
async function threadBusy(rt: AgentRuntime, run: Run): Promise<boolean> {
  if (!run.threadId) return false;
  const runs = await rt.store.listRuns(200);
  return runs.some(
    (item) =>
      item.id !== run.id &&
      item.threadId === run.threadId &&
      (item.status === "running" || item.status === "queued" || item.status === "waiting_approval"),
  );
}

/** Продолжить закрытую задачу ответом владельца. Ошибка хода не стирает сам ответ. */
export async function continueFinishedAnswer(rt: AgentRuntime, taken: TakenQuestion): Promise<Run> {
  const { run, question, kind, chatId, answer } = taken;
  try {
    if (await rt.isCanceled(run.id)) return run;
    const prompt =
      kind === "escalation"
        ? escalationContinuationPrompt(question, answer)
        : kind === "followup"
          ? followupContinuationPrompt(question, answer)
          : questionContinuationPrompt(question, answer);
    const turn = await rt.think(run, prompt, "hermes.question");
    const { text, status } = await finishServiceThink(rt, run, turn, { allowIdle: false });
    if (await rt.isCanceled(run.id)) return run;
    if (status !== "waiting_approval") {
      await rt.finishRun(run, status, text);
      await rt.addChat({ role: "agent", text, runId: run.id, chatId });
    }
    return run;
  } catch (e) {
    if (await rt.isCanceled(run.id)) return run;
    warn("approval", "продолжение после ответа на закрытую задачу упало", { error: String(e) });
    await rt.step(run.id, "error", String(e));
    await rt.finishRun(run, "failed", String(e));
    await rt.addChat({ role: "agent", text: redactInternal(`Не получилось: ${String(e)}`), runId: run.id, chatId });
    return run;
  } finally {
    inflight.delete(run.id);
  }
}
