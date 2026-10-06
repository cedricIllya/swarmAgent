import type { Run } from "@swarm/contracts";
import { discoverService, fetchPage, type DiscoveryInput, type DiscoveryResult, type FetchedPage } from "../discovery";
import type { WebCitation } from "../llm/openrouter";
import { recordUsage, type TaskRef } from "../core/usage";
import type { AgentRuntime } from "./index";

/** Что runtime умеет искать и читать в интернете от имени агента. */
export class Research {
  constructor(private readonly rt: AgentRuntime) {}

  /**
   * Сервиса нет в каталоге: ищем MCP в реестре и на домене, документацию в интернете,
   * проверяем найденный MCP. Подтверждённый MCP сразу записываем рецептом — Hermes
   * получит инструменты `mcp_<slug>_*` ещё до первого хода модели.
   */
  async discover(run: Run, input: DiscoveryInput): Promise<DiscoveryResult> {
    const { rt } = this;
    const result = await discoverService(input, {
      openRouter: rt.openRouter,
      model: rt.model,
      agentId: rt.cfg.agentId,
      onStep: (text, data) => rt.step(run.id, "tool", text, data),
      onUsage: (action, r) => recordUsage(rt.store, rt.taskRef(run), action, "runtime", r),
    });
    if (result.confirmed && result.draftRecipe) {
      const snap = await rt.store.readServices();
      const taken = snap?.recipes.find((r) => r.slug === result.slug);
      if (!taken) {
        await rt.services.applyReport({ type: "recipe", recipe: result.draftRecipe, runId: run.id });
      } else {
        await rt.step(run.id, "note", `слаг ${result.slug} уже занят рецептом «${taken.name}», рецепт не записан`);
      }
    }
    return result;
  }

  /** Один поиск в интернете с цитатами: для документации и вопросов «найди в интернете». */
  async webSearch(query: string, task: TaskRef, maxResults = 6): Promise<{ answer: string; results: WebCitation[] }> {
    const { rt } = this;
    const r = await rt.openRouter.chat(
      [
        {
          role: "user",
          content: `Найди в интернете и кратко ответь со ссылками на источники:\n${query.slice(0, 2000)}`,
        },
      ],
      { temperature: 0, maxTokens: 900, webSearch: { maxResults } },
      rt.model,
    );
    await recordUsage(rt.store, task, "web.search", "runtime", r);
    return { answer: r.text, results: r.citations };
  }

  /** Страница документации текстом без разметки, чтобы агент читал её одним вызовом. */
  async readDocs(url: string, maxChars = 20_000): Promise<FetchedPage | null> {
    return fetchPage(url, fetch, maxChars);
  }
}
