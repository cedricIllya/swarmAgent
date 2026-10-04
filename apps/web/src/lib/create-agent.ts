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
import { FlyClient, appNameFor, buildAgentMachineConfig, runtimeUrlFor } from "@swarm/fly";
import { renderAllFiles } from "@swarm/hermes-config";
import { allocateLocalPart, localPartFromName, validateLocalPart } from "@swarm/mail";
import type { TenantView } from "@swarm/identity";
import { env } from "@/env";
import { db } from "./db";
import { RuntimeClient } from "./runtime-client";

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

  let localPart: string;
  if (input.localPart) {
    const err = validateLocalPart(input.localPart);
    if (err) throw new Error(err);
    localPart = input.localPart.toLowerCase();
    if (await isAddressTaken(database, localPart, domain)) throw new Error(`Адрес ${localPart}@${domain} занят`);
  } else {
    localPart = await allocateLocalPart(localPartFromName(input.name), (c) => isAddressTaken(database, c, domain));
  }

  const { row, runtimeToken } = await insertAgent(database, {
    tenantId: tenant.id,
    name: input.name,
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

/** Шаблон скилла. `SKILL_TEMPLATE_DIR` задаётся в контейнере; в разработке — корень репозитория. */
async function skillTemplate(): Promise<string> {
  const dir = process.env.SKILL_TEMPLATE_DIR ?? path.resolve(process.cwd(), "../../agent-template");
  try {
    return await readFile(/*turbopackIgnore: true*/ path.join(dir, "swarm-worker", "SKILL.md"), "utf8");
  } catch {
    throw new Error(`agent-template/swarm-worker/SKILL.md не найден в ${dir}`);
  }
}

/** Env и файлы машины для текущего состояния агента. Используется при создании и смене модели. */
async function machineConfigFor(agent: AgentRow, runtimeToken: string, ownerEmail: string | null, volumeId: string) {
  const openRouterApiKey = env.openRouterApiKey;
  if (!openRouterApiKey) throw new Error("OPENROUTER_API_KEY не задан");

  const services = await buildSnapshot(db(), agent.tenantId);
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
      browserbaseApiKey: env.browserbase.apiKey,
      browserbaseProjectId: env.browserbase.projectId,
    },
    skillTemplate: await skillTemplate(),
  });

  const machineEnv: Record<string, string> = {
    AGENT_ID: agent.id,
    AGENT_NAME: agent.name,
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
  if (env.browserbase.apiKey) machineEnv["BROWSERBASE_API_KEY"] = env.browserbase.apiKey;
  if (env.browserbase.projectId) machineEnv["BROWSERBASE_PROJECT_ID"] = env.browserbase.projectId;

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

  await updateAgent(database, agent.id, { status: "provisioning", statusMessage: "Создаём приложение Fly", flyAppName: appName });
  await fly.ensureApp(appName);

  await updateAgent(database, agent.id, { statusMessage: "Создаём диск 10 GB" });
  const volume = await fly.ensureVolume(appName, "agent_data", 10);
  await updateAgent(database, agent.id, { flyVolumeId: volume.id });

  await updateAgent(database, agent.id, { statusMessage: "Запускаем Hermes и runtime" });
  const config = await machineConfigFor(agent, runtimeToken, ownerEmail, volume.id);
  const machine = await fly.createMachine(appName, { name: appName, config });
  await updateAgent(database, agent.id, { flyMachineId: machine.id });
  await fly.waitForState(appName, machine.id, "started", 180);

  await updateAgent(database, agent.id, {
    status: "running",
    statusMessage: null,
    runtimeUrl: runtimeUrlFor(appName),
  });
}

/** Смена модели или флага: переписать config.yaml и перезапустить машину. */
export async function reconfigureAgent(agentId: string, ownerEmail: string | null): Promise<void> {
  const database = db();
  const agent = await getAgentById(database, agentId);
  if (!agent?.flyAppName || !agent.flyMachineId || !agent.flyVolumeId) return;
  const fly = flyClient();
  const config = await machineConfigFor(agent, runtimeTokenOf(agent), ownerEmail, agent.flyVolumeId);
  await fly.updateMachine(agent.flyAppName, agent.flyMachineId, config);
}

/** Разослать свежий snapshot каталога всем агентам тенанта. */
export async function pushServicesToTenant(tenantId: string): Promise<void> {
  const database = db();
  const snapshot = await buildSnapshot(database, tenantId);
  const agents = await listAgents(database, tenantId);
  await Promise.allSettled(
    agents
      .filter((a) => a.status === "running")
      .map(async (a) => {
        const row = await getAgent(database, tenantId, a.id);
        const client = row ? RuntimeClient.for(row) : null;
        if (client) await client.syncServices({ snapshot });
      }),
  );
}

/** Удаление: Fly app вместе с диском, запись в базе, адрес освобождается. */
export async function destroyAgent(agent: AgentRow): Promise<void> {
  const database = db();
  await updateAgent(database, agent.id, { status: "deleting", statusMessage: "Удаляем машину" });
  if (agent.flyAppName && env.fly.apiToken) {
    await flyClient().destroyApp(agent.flyAppName);
  }
  await deleteAgentRow(database, agent.id);
}
