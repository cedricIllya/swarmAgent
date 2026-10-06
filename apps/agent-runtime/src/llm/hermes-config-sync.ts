import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServicesSnapshot } from "@swarm/contracts";
import { replaceMcpServers } from "@swarm/hermes-config";
import { warn } from "../core/log";

/**
 * Переписать `mcp_servers` в config.yaml на volume. Hermes gateway следит за файлом
 * и подключает новые серверы без рестарта машины.
 */
export async function syncHermesMcp(dataDir: string, services: ServicesSnapshot, skyvernEnabled: boolean): Promise<void> {
  const file = path.join(dataDir, "config.yaml");
  let current: string;
  try {
    current = await readFile(file, "utf8");
  } catch {
    return;
  }
  let next: string;
  try {
    next = replaceMcpServers(current, services, skyvernEnabled);
  } catch (e) {
    warn("hermes-config", "config.yaml не разобран, MCP не обновлён", { error: String(e) });
    return;
  }
  if (next === current) return;
  const tmp = `${file}.tmp`;
  await writeFile(tmp, next, { mode: 0o644 });
  await rename(tmp, file);
  await chmod(file, 0o644);
}
