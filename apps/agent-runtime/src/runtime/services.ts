import { mergeCredential, type RuntimeReport, type RuntimeState } from "@swarm/contracts";
import { emitRuntime } from "../events";
import { matchRecipe } from "../domains";
import { syncHermesMcp } from "../hermes-config-sync";
import type { AgentRuntime } from "./index";

/**
 * Каталог сервисов агента: рецепты и секреты в `services.json`, их отражение
 * в `mcp_servers` Hermes и в карточке на сайте.
 */
export class ServiceCatalog {
  constructor(private readonly rt: AgentRuntime) {}

  async connected(): Promise<RuntimeState["connectedServices"]> {
    const snap = await this.rt.store.readServices();
    if (!snap) return [];
    return snap.recipes
      .filter((r) => snap.credentials.some((c) => c.slug === r.slug))
      .map((r) => {
        const cred = snap.credentials.find((c) => c.slug === r.slug);
        return {
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          hasCredential: true,
          accountEmail: cred?.accountEmail ?? null,
          accountName: cred?.accountName ?? null,
          hasPassword: Boolean(cred?.password),
        };
      });
  }

  async publish(): Promise<void> {
    emitRuntime({ type: "services", connectedServices: await this.connected() });
  }

  /** Переписать `mcp_servers` Hermes по текущему `services.json` и обновить карточку. */
  async refreshHermesMcp(): Promise<void> {
    const { rt } = this;
    const snap = await rt.store.readServices();
    if (!snap) return;
    await syncHermesMcp(rt.cfg.dataDir, snap, Boolean(rt.cfg.skyvernApiKey));
    await this.publish();
  }

  /**
   * Новый рецепт или секрет: на control plane, в локальный `services.json`,
   * в `config.yaml` Hermes и строкой в журнал задачи.
   */
  async applyReport(
    input: RuntimeReport,
    opts: { quiet?: boolean } = {},
  ): Promise<{ slug: string; name: string; kind: "mcp" | "api" | "browser" }> {
    const { rt } = this;
    const prev =
      input.type === "credential"
        ? (await rt.store.readServices())?.credentials.find((c) => c.slug === input.credential.slug)
        : undefined;
    const body = input.type === "credential" ? { ...input, credential: mergeCredential(prev, input.credential) } : input;
    await rt.controlPlane.report(body);
    const snap = await rt.store.readServices();
    const reported =
      body.type === "recipe"
        ? { name: body.recipe.name, kind: body.recipe.kind, slug: body.recipe.slug }
        : { name: body.credential.slug, kind: body.credential.kind, slug: body.credential.slug };
    if (snap) {
      if (body.type === "recipe") {
        snap.recipes = [...snap.recipes.filter((r) => r.slug !== body.recipe.slug), body.recipe];
      } else {
        snap.credentials = [...snap.credentials.filter((r) => r.slug !== body.credential.slug), body.credential];
      }
      await rt.store.writeServices(snap);
      await this.refreshHermesMcp();
    }
    const kindLabel = { mcp: "MCP", api: "API", browser: "браузер" } as const;
    const running = opts.quiet
      ? null
      : body.runId
        ? await rt.store.getRun(body.runId)
        : (await rt.store.listRuns(20)).find((r) => r.status === "running");
    if (running) {
      const what = body.type === "recipe" ? "найден способ входа в" : "подключён сервис";
      await rt.step(running.id, "note", `${what} ${reported.name} (${kindLabel[reported.kind]})`);
    }
    return reported;
  }

  /** Рецепт из каталога по доменам ссылок и подсказке классификатора. */
  async knownRecipe(hosts: string[]): Promise<ReturnType<typeof matchRecipe>> {
    const services = await this.rt.store.readServices();
    return services ? matchRecipe(services.recipes, hosts.filter(Boolean)) : null;
  }
}
