import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CreateAgentInput } from "@swarm/contracts";
import {
  deleteAgent as deleteAgentRow,
  getAgent,
  getAgentById,
  insertAgent,
  isAddressTaken,
  listAgents,
  runtimeTokenOf,
  updateAgent,
  type AgentRow,
} from "@swarm/agents";
import { buildSnapshot } from "@swarm/connections";
import { inArray, schema } from "@swarm/db";
import { AGENT_VOLUME_GB, FlyClient, FlyError, appNameFor, buildAgentMachineConfig, runtimeUrlFor } from "@swarm/fly";
import { renderAllFiles } from "@swarm/hermes-config";
import { allocateLocalPart, localPartForOwner } from "@swarm/mail";
import type { TenantView } from "@swarm/identity";
import { t } from "@/i18n";
import { env } from "@/env";
import { db } from "./db";
import { provisionVerdict } from "./provision-verdict";
import { awakeRuntime } from "./runtime-client";

/**
 * Единственное место, которое по очереди зовёт адрес, реестр, Fly и конфиг Hermes.
 * Запись в базе появляется сразу; машина поднимается в фоне, статус виден в UI.
 */
export async function createAgent(
  tenant: TenantView,
  owner: { email: string },
  input: CreateAgentInput,
): Promise<AgentRow> {
  const database = db();
  const domain = (input.domain ?? tenant.agentsDomain ?? env.agentsDomain).toLowerCase();

  const localPart = await allocateLocalPart(
    localPartForOwner(owner.email, `${input.firstName} ${input.lastName}`),
    (c) => isAddressTaken(database, c, domain),
  );

  const { row, runtimeToken } = await insertAgent(database, {
    tenantId: tenant.id,
    name: `${input.firstName} ${input.lastName}`,
    firstName: input.firstName,
    lastName: input.lastName,
    model: input.model,
    localPart,
    domain,
  });

  void provision(row, runtimeToken, owner.email).catch(async (e) => {
    await updateAgent(database, row.id, { status: "failed", statusMessage: String(e) });
  });

  return row;
}

function flyClient(): FlyClient {
  const token = env.fly.apiToken;
  if (!token) throw new Error("FLY_API_TOKEN не задан: машину агента создать нельзя");
  return new FlyClient({ apiToken: token, org: env.fly.org, region: env.fly.region });
}

/** Общий скилл агента. `SKILL_TEMPLATE_DIR` задаётся в контейнере; в разработке — корень репозитория. */
async function workerSkillTemplate(): Promise<string> {
  const dir = process.env.SKILL_TEMPLATE_DIR ?? path.resolve(process.cwd(), "../../agent-template");
  try {
    return await readFile(/*turbopackIgnore: true*/ path.join(dir, "swarm-worker/SKILL.md"), "utf8");
  } catch {
    throw new Error(`agent-template/swarm-worker/SKILL.md не найден в ${dir}`);
  }
}

/** Env и файлы машины для текущего состояния агента. Используется при создании и смене модели. */
async function machineConfigFor(agent: AgentRow, runtimeToken: string, ownerEmail: string | null, volumeId: string) {
  const openRouterApiKey = env.openRouterApiKey;
  if (!openRouterApiKey) throw new Error("OPENROUTER_API_KEY не задан");

  const services = await buildSnapshot(db(), agent.id);
  const email = `${agent.localPart}@${agent.domain}`;

  const files = renderAllFiles({
    config: {
      agentId: agent.id,
      agentName: agent.name,
      email,
      model: agent.model,
      autonomous: agent.autonomous,
      services,
      skyvern: { enabled: Boolean(env.skyvernApiKey) },
    },
    env: {
      openRouterApiKey,
      runtimeToken,
      skyvernApiKey: env.skyvernApiKey,
    },
    skillTemplate: await workerSkillTemplate(),
  });

  const machineEnv: Record<string, string> = {
    AGENT_ID: agent.id,
    AGENT_NAME: agent.name,
    ...(agent.firstName ? { AGENT_FIRST_NAME: agent.firstName } : {}),
    ...(agent.lastName ? { AGENT_LAST_NAME: agent.lastName } : {}),
    AGENT_EMAIL: email,
    AGENT_MODEL: agent.model,
    AGENT_AUTONOMOUS: String(agent.autonomous),
    RUNTIME_TOKEN: runtimeToken,
    SWARM_RUNTIME_TOKEN: runtimeToken,
    HERMES_API_KEY: runtimeToken,
    CONTROL_PLANE_URL: env.appUrl,
    OPENROUTER_API_KEY: openRouterApiKey,
    TZ: "UTC",
  };
  if (ownerEmail) machineEnv["OWNER_EMAIL"] = ownerEmail;
  if (env.skyvernApiKey) machineEnv["SKYVERN_API_KEY"] = env.skyvernApiKey;

  return buildAgentMachineConfig({
    volumeId,
    hermesImage: env.fly.hermesImage,
    runtimeImage: env.fly.runtimeImage,
    env: machineEnv,
    files,
  });
}

async function provision(agent: AgentRow, runtimeToken: string, ownerEmail: string): Promise<void> {
  const database = db();
  const fly = flyClient();
  const appName = appNameFor(agent.id);

  await updateAgent(database, agent.id, { status: "provisioning", statusMessage: t("status.preparing"), flyAppName: appName });
  await fly.ensureApp(appName);
  await fly.ensureFlycast(appName);

  await updateAgent(database, agent.id, { statusMessage: t("status.preparingStorage") });
  const volume = await fly.ensureVolume(appName, "agent_data", AGENT_VOLUME_GB);
  await updateAgent(database, agent.id, { flyVolumeId: volume.id });

  await updateAgent(database, agent.id, { statusMessage: t("status.starting") });
  const config = await machineConfigFor(agent, runtimeToken, ownerEmail, volume.id);
  const machine = await fly.createMachine(appName, { name: appName, config });
  await updateAgent(database, agent.id, { flyMachineId: machine.id, statusMessage: BOOTING_MESSAGE });
  try {
    await fly.waitForState(appName, machine.id, "started", FIRST_BOOT_WAIT_SEC);
  } catch (e) {
    // Первый запуск тянет образы Hermes и runtime на новый хост: бывает дольше любого ожидания.
    // Машина создана и дойдёт сама; статус «запускается» дочинит reconcileProvisioning.
    if (e instanceof FlyError && e.status === 408) {
      await updateAgent(database, agent.id, { status: "provisioning", statusMessage: BOOTING_MESSAGE });
      return;
    }
    throw e;
  }
  await markRunning(agent.id, appName);
}

/** Первый старт машины: Fly готовит два образа, на новом хосте это минуты, а не секунды. */
const FIRST_BOOT_WAIT_SEC = 600;
const BOOTING_MESSAGE = t("status.booting");

async function markRunning(agentId: string, appName: string): Promise<void> {
  await updateAgent(db(), agentId, {
    status: "running",
    statusMessage: null,
    runtimeUrl: runtimeUrlFor(appName),
    runtimeRelease: env.release ?? null,
  });
}

/**
 * Агенты, чья машина уже создана, но статус застрял: ожидание первого старта вышло, или
 * control plane перезапустили посреди provision и промис пропал. Машина стартовала (пусть и
 * уже уснула) — агент работает; всё ещё поднимается — так и пишем; машины нет — ошибка остаётся.
 */
export async function reconcileProvisioning(): Promise<{ recovered: number; booting: number }> {
  const database = db();
  const rows: AgentRow[] = await database
    .select()
    .from(schema.agents)
    .where(inArray(schema.agents.status, ["provisioning", "failed"]));
  const stuck = rows.filter((a) => a.flyAppName && a.flyMachineId);
  if (!stuck.length) return { recovered: 0, booting: 0 };
  const fly = flyClient();
  let recovered = 0;
  let booting = 0;
  for (const agent of stuck) {
    try {
      const machine = await fly.getMachine(agent.flyAppName!, agent.flyMachineId!);
      const verdict = provisionVerdict(machine?.state ?? null);
      if (verdict === "running") {
        await markRunning(agent.id, agent.flyAppName!);
        recovered += 1;
      } else if (verdict === "booting") {
        booting += 1;
        if (agent.status !== "provisioning" || agent.statusMessage !== BOOTING_MESSAGE) {
          await updateAgent(database, agent.id, { status: "provisioning", statusMessage: BOOTING_MESSAGE });
        }
      }
    } catch (e) {
      console.warn(`[provision] ${agent.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { recovered, booting };
}

/**
 * Переписать конфиг машины и перезапустить её: смена модели, новый образ runtime.
 * Образ берётся текущий (`env.fly.runtimeImage`), поэтому машина получает релиз этого control plane.
 */
export async function reconfigureAgent(agentId: string, ownerEmail: string | null): Promise<void> {
  const database = db();
  const agent = await getAgentById(database, agentId);
  if (!agent?.flyAppName || !agent.flyMachineId || !agent.flyVolumeId) return;
  const fly = flyClient();
  await fly.ensureFlycast(agent.flyAppName);
  const config = await machineConfigFor(agent, runtimeTokenOf(agent), ownerEmail, agent.flyVolumeId);
  await fly.updateMachine(agent.flyAppName, agent.flyMachineId, config);
  await updateAgent(database, agent.id, { runtimeUrl: runtimeUrlFor(agent.flyAppName), runtimeRelease: env.release ?? null });
}

/** Отдать агенту его snapshot: общий каталог и только его секреты. */
export async function pushServicesToAgent(agent: AgentRow): Promise<void> {
  const snapshot = await buildSnapshot(db(), agent.id);
  const client = await awakeRuntime(agent);
  if (client) await client.syncServices({ snapshot });
}

/**
 * Каталог изменился — разослать его запущенным агентам тенанта.
 * Каждый получает свой snapshot, чужие секреты никуда не уезжают.
 */
export async function pushServicesToTenant(tenantId: string): Promise<void> {
  const database = db();
  const agents = await listAgents(database, tenantId);
  await Promise.allSettled(
    agents
      .filter((a) => a.status === "running")
      .map(async (a) => {
        const row = await getAgent(database, tenantId, a.id);
        if (row) await pushServicesToAgent(row);
      }),
  );
}

/** Удаление: Fly app вместе с диском, запись в базе, адрес освобождается. */
export async function destroyAgent(agent: AgentRow): Promise<void> {
  const database = db();
  await updateAgent(database, agent.id, { status: "deleting", statusMessage: t("status.deletingAgent") });
  if (agent.flyAppName && env.fly.apiToken) {
    await flyClient().destroyApp(agent.flyAppName);
  }
  await deleteAgentRow(database, agent.id);
}
