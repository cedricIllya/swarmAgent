import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServicesSnapshot } from "@swarm/contracts";
import { replaceMcpServers, useOpenRouterUsageProxy } from "@swarm/hermes-config";
import { warn } from "../core/log";

/**
 * Переписать `mcp_servers` в config.yaml на volume. Hermes gateway следит за файлом
 * и подключает новые серверы без рестарта машины.
 */
export async function syncHermesMcp(dataDir: string, services: ServicesSnapshot, skyvernEnabled: boolean): Promise<void> {
  await rewriteHermesConfig(dataDir, (current) => useOpenRouterUsageProxy(replaceMcpServers(current, services, skyvernEnabled)));
}

/** До старта Hermes: его вызовы модели идут в локальный прокси, даже если config.yaml старый. */
export async function ensureOpenRouterUsageProxy(dataDir: string): Promise<void> {
  await rewriteHermesConfig(dataDir, useOpenRouterUsageProxy);
}

async function rewriteHermesConfig(dataDir: string, edit: (current: string) => string): Promise<void> {
  const file = path.join(dataDir, "config.yaml");
  let current: string;
  try {
    current = await readFile(file, "utf8");
  } catch {
    return;
  }
  let next: string;
  try {
    next = edit(current);
  } catch (e) {
    warn("hermes-config", "config.yaml не разобран", { error: String(e) });
    return;
  }
  if (next === current) return;
  const tmp = `${file}.tmp`;
  await writeFile(tmp, next, { mode: 0o644 });
  await rename(tmp, file);
  await chmod(file, 0o644);
}
