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
import { eq, inArray, schema } from "@swarm/db";
import {
  AGENTS_APP_NAME,
  AGENT_VOLUME_GB,
  FlyClient,
  FlyError,
  RUNTIME_PORT,
  VOLUME_NAME,
  allocateExternalPort,
  buildAgentMachineConfig,
  externalPortFromUrl,
  externalPortsFromConfig,
  machineNameFor,
  runtimeUrlFor,
  volumeNameFor,
  type FlyMachine,
} from "@swarm/fly";
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
async function machineConfigFor(
  agent: AgentRow,
  runtimeToken: string,
  ownerEmail: string | null,
  volumeId: string,
  volumeName: string,
  externalPort: number,
) {
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
    volumeName,
    externalPort,
    hermesImage: env.fly.hermesImage,
    runtimeImage: env.fly.runtimeImage,
    env: machineEnv,
    files,
  });
}

async function provision(agent: AgentRow, runtimeToken: string, ownerEmail: string): Promise<void> {
  const database = db();
  const fly = flyClient();
  const appName = env.fly.agentsApp;
  const volumeName = volumeNameFor(agent.id);

  await updateAgent(database, agent.id, { status: "provisioning", statusMessage: t("status.preparing"), flyAppName: appName });
  await fly.ensureApp(appName);
  await fly.ensureFlycast(appName);
  await fly.assertNoPublicIp(appName);

  await updateAgent(database, agent.id, { statusMessage: t("status.preparingStorage") });
  const volume = await fly.ensureVolume(appName, volumeName, AGENT_VOLUME_GB);
  await updateAgent(database, agent.id, { flyVolumeId: volume.id });

  await updateAgent(database, agent.id, { statusMessage: t("status.starting") });
  const machines = await fly.listMachines(appName);
  let existing = machines.find((m) => m.name === machineNameFor(agent.id));
  if (existing && !externalPortsFromConfig(existing.config)[0]) {
    existing = (await fly.getMachine(appName, existing.id)) ?? existing;
  }
  const port = portFor(agent.id, machines, existing);
  const machine =
    existing ??
    (await fly.createMachine(appName, {
      name: machineNameFor(agent.id),
      config: await machineConfigFor(agent, runtimeToken, ownerEmail, volume.id, volumeName, port),
    }));
  await updateAgent(database, agent.id, {
    flyMachineId: machine.id,
    runtimeUrl: runtimeUrlFor(appName, port),
    statusMessage: BOOTING_MESSAGE,
  });
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
  await markRunning(agent.id, appName, port);
}

/** Порт уже созданной машины, иначе первый свободный. Чужой порт не переиспользуем. */
function portFor(agentId: string, machines: FlyMachine[], existing: FlyMachine | undefined): number {
  if (existing) {
    const found = externalPortsFromConfig(existing.config)[0];
    if (!found) throw new Error("у машины агента нет порта");
    return found;
  }
  return allocateExternalPort(
    agentId,
    machines.flatMap((m) => externalPortsFromConfig(m.config)),
  );
}

/** Первый старт машины: Fly готовит два образа, на новом хосте это минуты, а не секунды. */
const FIRST_BOOT_WAIT_SEC = 600;
const BOOTING_MESSAGE = t("status.booting");

async function markRunning(agentId: string, appName: string, port: number): Promise<void> {
  await updateAgent(db(), agentId, {
    status: "running",
    statusMessage: null,
    runtimeUrl: runtimeUrlFor(appName, port),
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
        const port = externalPortFromUrl(agent.runtimeUrl) ?? externalPortsFromConfig(machine?.config)[0];
        if (!port) throw new Error("у машины агента нет порта");
        await markRunning(agent.id, agent.flyAppName!, port);
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
  if (isSharedAgentsApp(agent.flyAppName)) await fly.assertNoPublicIp(agent.flyAppName);
  const shared = isSharedAgentsApp(agent.flyAppName);
  const port = externalPortFromUrl(agent.runtimeUrl);
  if (shared && !port) throw new Error("у агента нет порта машины");
  const externalPort = port ?? RUNTIME_PORT;
  const volumeName = shared ? volumeNameFor(agent.id) : VOLUME_NAME;
  const config = await machineConfigFor(agent, runtimeTokenOf(agent), ownerEmail, agent.flyVolumeId, volumeName, externalPort);
  await fly.updateMachine(agent.flyAppName, agent.flyMachineId, config);
  await updateAgent(database, agent.id, {
    runtimeUrl: runtimeUrlFor(agent.flyAppName, externalPort),
    runtimeRelease: env.release ?? null,
  });
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

/**
 * Удаление машины и диска этого агента. Общее приложение остаётся.
 * Агент, созданный ещё в своём приложении `swarm-<id>`, по-прежнему сносится вместе с ним.
 */
export async function destroyAgent(agent: AgentRow): Promise<void> {
  const database = db();
  await updateAgent(database, agent.id, { status: "deleting", statusMessage: t("status.deletingAgent") });
  if (agent.flyAppName && env.fly.apiToken) {
    const fly = flyClient();
    if (await sharesAgentsApp(agent.flyAppName)) await destroySharedMachine(fly, agent);
    else await fly.destroyApp(agent.flyAppName);
  }
  await deleteAgentRow(database, agent.id);
}

function isSharedAgentsApp(appName: string): boolean {
  return appName === env.fly.agentsApp || appName === AGENTS_APP_NAME;
}

/** В общем приложении нельзя снести апку: там диски остальных. Одинокий старый `swarm-<id>` сносится целиком. */
async function sharesAgentsApp(appName: string): Promise<boolean> {
  if (isSharedAgentsApp(appName)) return true;
  const rows = await db()
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.flyAppName, appName))
    .limit(2);
  return rows.length > 1;
}

/** Машина, потом диск. Приложение агентов не трогаем. */
async function destroySharedMachine(fly: FlyClient, agent: AgentRow): Promise<void> {
  const appName = agent.flyAppName;
  if (!appName) return;
  if (agent.flyMachineId) {
    await fly.destroyMachine(appName, agent.flyMachineId);
    try {
      await fly.waitForState(appName, agent.flyMachineId, "destroyed", 90);
    } catch (e) {
      if (!(e instanceof FlyError && e.status === 404)) throw e;
    }
  }
  if (!agent.flyVolumeId) return;
  try {
    await fly.destroyVolume(appName, agent.flyVolumeId);
  } catch (e) {
    if (!(e instanceof FlyError && e.status === 409) || !agent.flyMachineId) throw e;
    await fly.waitForState(appName, agent.flyMachineId, "destroyed", 30).catch(() => undefined);
    await fly.destroyVolume(appName, agent.flyVolumeId);
  }
}
