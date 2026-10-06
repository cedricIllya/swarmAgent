import { parseUserQuestion, type Run } from "@swarm/contracts";
import { questionContinuationPrompt } from "../llm/prompts";
import { redactInternal } from "../core/redact";
import { warn } from "../core/log";
import type { AgentRuntime } from "../runtime";
import { finishServiceThink } from "./service-work";

/** Вопрос уже снят с карточки, ход модели ещё впереди. */
export interface TakenQuestion {
  run: Run;
  question: string;
  chatId: string;
  answer: string;
}

const inflight = new Set<string>();

/**
 * Задача уже закрыта, но в итоге остался нумерованный вопрос.
 * У письма threadId — Message-ID, не чат, поэтому ответ нельзя слать в /chat.
 */
export async function takeFinishedAnswer(rt: AgentRuntime, runId: string, answer: string): Promise<TakenQuestion | null> {
  const text = answer.trim();
  if (!text || inflight.has(runId)) return null;
  const run = await rt.store.getRun(runId);
  if (!run || (run.status !== "done" && run.status !== "failed" && run.status !== "escalated")) return null;
  const question = parseUserQuestion(run.summary);
  if (!question) return null;

  inflight.add(runId);
  try {
    run.status = "running";
    run.finishedAt = null;
    run.summary = "";
    await rt.store.saveRun(run);
    const chatId = await rt.chatIdForRun(run);
    await rt.addChat({ role: "user", text, runId: run.id, chatId });
    await rt.step(run.id, "note", "ответ человека получен");
    return { run, question: question.prompt, chatId, answer: text };
  } catch (e) {
    inflight.delete(runId);
    throw e;
  }
}

/** Продолжить закрытую задачу ответом владельца. Ошибка хода не стирает сам ответ. */
export async function continueFinishedAnswer(rt: AgentRuntime, taken: TakenQuestion): Promise<Run> {
  const { run, question, chatId, answer } = taken;
  try {
    if (await rt.isCanceled(run.id)) return run;
    const turn = await rt.think(run, questionContinuationPrompt(question, answer), "hermes.question");
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
