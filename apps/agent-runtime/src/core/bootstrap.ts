import { copyFile, mkdir, readdir, rm, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { log } from "./log";

/**
 * Control plane кладёт config.yaml, .env, cron/jobs.json, скилл и services.json
 * в /bootstrap контейнера. Здесь они переезжают на volume. Перезаписываем
 * всегда: источник правды — control plane; остальное на volume не трогаем.
 */
export async function applyBootstrap(bootstrapDir: string, dataDir: string): Promise<number> {
  let copied = 0;
  async function walk(rel: string): Promise<void> {
    const abs = path.join(bootstrapDir, rel);
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const childRel = path.join(rel, e.name);
      if (e.isDirectory()) {
        await walk(childRel);
        continue;
      }
      const src = path.join(bootstrapDir, childRel);
      const dst = path.join(dataDir, childRel);
      await mkdir(path.dirname(dst), { recursive: true });
      await copyFile(src, dst);
      const mode = (await stat(src)).mode & 0o777;
      if (mode) await chmod(dst, mode).catch(() => undefined);
      copied++;
    }
  }
  await walk("");
  if (copied) log("bootstrap", "конфигурация разложена на volume", { copied });
  return copied;
}

const GATEWAY_RECORDS = ["gateway.lock", "gateway.sock", "gateway_state.json", ".local/state/hermes/gateway-locks/host-gateway.lock"];

/**
 * Hermes пишет PID своего gateway на volume. После холодного старта машины этот PID
 * принадлежит другому процессу, и `gateway run --replace` отказывается запускаться:
 * api_server не поднимается, задачи уходят без инструментов. Контейнер Hermes стартует
 * только после healthy runtime, поэтому к этому моменту живого gateway нет.
 */
export async function clearGatewayRecords(dataDir: string): Promise<string[]> {
  const names = await readdir(dataDir).catch(() => [] as string[]);
  const temps = names.filter((n) => n.startsWith(".gateway_state_") && n.endsWith(".tmp"));
  const removed: string[] = [];
  for (const rel of [...GATEWAY_RECORDS, ...temps]) {
    const abs = path.join(dataDir, rel);
    const exists = await stat(abs).then(() => true, () => false);
    if (!exists) continue;
    await rm(abs, { force: true });
    removed.push(rel);
  }
  if (removed.length) log("bootstrap", "старые записи gateway Hermes удалены", { removed });
  return removed;
}
