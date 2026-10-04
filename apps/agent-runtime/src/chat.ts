import type { Run } from "@swarm/contracts";
import { chatTaskPrompt } from "./prompts";
import type { AgentRuntime } from "./runtime";
import { warn } from "./log";

/** Чат на карточке агента: задание в обход подключённых сервисов. */
export async function handleChat(rt: AgentRuntime, message: string, author: string): Promise<Run> {
  const run = await rt.createRun("chat", message, null);
  await rt.addChat({ role: "user", text: message, runId: run.id });
  void (async () => {
    try {
      const text = await rt.think(run, chatTaskPrompt(message, author));
      const current = await rt.store.getRun(run.id);
      if (current?.status === "waiting_approval") return;
      await rt.finishRun(run, "done", text);
      await rt.addChat({ role: "agent", text, runId: run.id });
    } catch (e) {
      warn("chat", "задача упала", { error: String(e) });
      await rt.step(run.id, "error", String(e));
      await rt.finishRun(run, "failed", String(e));
      await rt.addChat({ role: "agent", text: `Не получилось: ${String(e)}`, runId: run.id });
    }
  })();
  return run;
}
