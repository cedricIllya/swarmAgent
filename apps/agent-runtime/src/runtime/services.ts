import path from "node:path";
import { rm } from "node:fs/promises";
import { mergeCredential, type RuntimeReport, type ServicesSnapshot, type RuntimeState } from "@swarm/contracts";
import { serviceProfileDir } from "../browser/stagehand";
import { emitRuntime } from "../events";
import { matchRecipe } from "../domains";
import { syncHermesMcp } from "../hermes-config-sync";
import { warn } from "../log";
import type { AgentRuntime } from "./index";

/** Секреты, которые были в прошлом снимке и пропали в новом. */
export function droppedCredentialSlugs(
  prev: Array<{ slug: string }> | undefined,
  next: Array<{ slug: string }>,
): string[] {
  const keep = new Set(next.map((c) => c.slug));
  return [...new Set((prev ?? []).map((c) => c.slug).filter((slug) => !keep.has(slug)))];
}

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
          // Способ — тот, которым этот агент реально ходит: рецепт может быть MCP, а доступ — только браузер.
          kind: cred?.kind ?? r.kind,
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

  /**
   * Доступ сняли на control plane: закрыть браузер этого сервиса и стереть профиль,
   * чтобы cookies не оставляли вход после нового `services.json`.
   */
  async dropRemoved(prev: ServicesSnapshot | null, next: ServicesSnapshot): Promise<void> {
    for (const slug of droppedCredentialSlugs(prev?.credentials, next.credentials)) {
      try {
        await this.rt.browser.closeForService(slug);
      } catch (e) {
        warn("services", "браузер сервиса не закрылся", { slug, error: String(e) });
      }
      const dir = serviceProfileDir(this.rt.store, slug);
      const root = this.rt.store.dir("browser-profiles");
      if (!dir.startsWith(root + path.sep)) continue;
      await rm(dir, { recursive: true, force: true }).catch((e) =>
        warn("services", "профиль браузера не удалён", { slug, error: String(e) }),
      );
    }
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
