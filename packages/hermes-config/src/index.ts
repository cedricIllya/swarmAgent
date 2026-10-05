import type { ServicesSnapshot } from "@swarm/contracts";
import { parse, stringify } from "yaml";

/** Где на машине агента живёт всё его состояние. */
export const HERMES_HOME = "/opt/data";
export const RUNTIME_PORT = 8787;

export interface HermesConfigInput {
  agentId: string;
  agentName: string;
  email: string;
  model: string;
  autonomous: boolean;
  /** Snapshot каталога и секретов тенанта: MCP-серверы попадают в config.yaml. */
  services: ServicesSnapshot;
  skyvern: { enabled: boolean };
}

/**
 * Блок `mcp_servers` для Hermes. Ключи — по его спецификации:
 * `tools.include`, `transport: sse` только для SSE, без `description`.
 * Skyvern в MCP не попадает: в контейнере Hermes нет его CLI, а вход и регистрацию
 * runtime делает сам через `/invite/accept` и `/skyvern/login`.
 */
export function renderMcpServers(services: ServicesSnapshot, _skyvernEnabled: boolean): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};

  for (const recipe of services.recipes) {
    if (recipe.kind !== "mcp" || !recipe.mcp) continue;
    const cred = services.credentials.find((c) => c.slug === recipe.slug);
    const headers: Record<string, string> = {};
    const token = cred?.token ?? cred?.oauth?.accessToken;
    if (recipe.mcp.auth !== "none" && token) headers["Authorization"] = `Bearer ${token}`;
    const entry: Record<string, unknown> = { url: recipe.mcp.url };
    if (recipe.mcp.transport === "sse") entry["transport"] = "sse";
    if (Object.keys(headers).length) entry["headers"] = headers;
    if (recipe.mcp.includeTools.length) entry["tools"] = { include: recipe.mcp.includeTools };
    mcpServers[recipe.slug] = entry;
  }

  return mcpServers;
}

/**
 * Подменить только `mcp_servers` в уже лежащем `config.yaml`.
 * Остальные ключи Hermes не трогаем: gateway подхватит файл сам.
 */
export function replaceMcpServers(configYaml: string, services: ServicesSnapshot, skyvernEnabled: boolean): string {
  const doc = parse(configYaml);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return configYaml;
  const next = doc as Record<string, unknown>;
  next["mcp_servers"] = renderMcpServers(services, skyvernEnabled);
  return `# Сгенерировано Swarm Agent. Правки руками перепишутся при смене модели.\n${stringify(next)}`;
}

/**
 * `config.yaml` Hermes: провайдер OpenRouter, модель агента, MCP-серверы из
 * общего каталога с секретами тенанта.
 */
export function renderConfigYaml(input: HermesConfigInput): string {
  const doc = {
    model: {
      provider: "openrouter",
      default: input.model,
      base_url: "https://openrouter.ai/api/v1",
    },
    agent: {
      name: input.agentName,
      max_turns: 60,
    },
    display: { show_reasoning: false },
    memory: { enabled: true },
    skills: { auto_create: true },
    terminal: { backend: "local" },
    toolsets: ["default", "mcp", "skills", "memory", "cronjob"],
    mcp_servers: renderMcpServers(input.services, input.skyvern.enabled),
    swarm: {
      agent_id: input.agentId,
      email: input.email,
      autonomous: input.autonomous,
      runtime_url: `http://127.0.0.1:${RUNTIME_PORT}`,
    },
  };

  return `# Сгенерировано Swarm Agent. Правки руками перепишутся при смене модели.\n${stringify(doc)}`;
}

export interface HermesEnvInput {
  openRouterApiKey: string;
  runtimeToken: string;
  skyvernApiKey?: string | undefined;
}

/**
 * `.env` для Hermes внутри `HERMES_HOME`. `api_server` — OpenAI-совместимый вход,
 * через который runtime даёт Hermes задачи; ключом служит runtime token.
 */
export function renderHermesEnv(input: HermesEnvInput): string {
  const lines = [
    `HERMES_HOME=${HERMES_HOME}`,
    `OPENROUTER_API_KEY=${input.openRouterApiKey}`,
    `API_SERVER_ENABLED=true`,
    `API_SERVER_HOST=127.0.0.1`,
    `API_SERVER_PORT=8642`,
    `API_SERVER_KEY=${input.runtimeToken}`,
    `SWARM_RUNTIME_TOKEN=${input.runtimeToken}`,
  ];
  if (input.skyvernApiKey) lines.push(`SKYVERN_API_KEY=${input.skyvernApiKey}`);
  return lines.join("\n") + "\n";
}

/**
 * `cron/jobs.json`: раз в 15 минут Hermes будит runtime. Новая почта приходит
 * вебхуком; тик смотрит подключённые сервисы и отложенные письма.
 */
export function renderCronJobs(): string {
  return JSON.stringify(
    {
      version: 1,
      jobs: [
        {
          id: "swarm-tick",
          name: "Проверить сервисы и отложенные письма",
          schedule: "every 15m",
          enabled: true,
          prompt:
            "Выполни скилл swarm-worker в режиме tick: вызови POST http://127.0.0.1:8787/tick и действуй по его ответу. " +
            "Если задач нет — ответь одним словом «пусто».",
          deliver: "local",
        },
      ],
    },
    null,
    2,
  );
}

export interface WorkerSkillInput {
  agentName: string;
  email: string;
}

/** Текст скилла `skills/swarm-worker/SKILL.md`. Шаблон лежит в `agent-template/`. */
export function renderWorkerSkill(template: string, input: WorkerSkillInput): string {
  return template.replaceAll("{{AGENT_NAME}}", input.agentName).replaceAll("{{AGENT_EMAIL}}", input.email);
}

export interface RenderedFile {
  /** Путь относительно HERMES_HOME. Runtime копирует их туда при старте. */
  path: string;
  content: string;
  mode?: string;
}

/**
 * Volume читают два контейнера под разными uid. `0600` для Hermes — Permission denied.
 * Снаружи volume не смонтирован, поэтому общие файлы — `0644`.
 */
export const SHARED_FILE_MODE = "0644";

/** Все файлы, которые control plane кладёт на volume при создании и смене настроек. */
export function renderAllFiles(args: {
  config: HermesConfigInput;
  env: HermesEnvInput;
  skillTemplate: string;
  /** Рецепты сервисов, которые кладём в skills/<slug>/SKILL.md вместе со swarm-worker. */
  serviceSkills?: Array<{ slug: string; content: string }>;
}): RenderedFile[] {
  return [
    { path: "config.yaml", content: renderConfigYaml(args.config), mode: SHARED_FILE_MODE },
    { path: ".env", content: renderHermesEnv(args.env), mode: SHARED_FILE_MODE },
    { path: "cron/jobs.json", content: renderCronJobs(), mode: SHARED_FILE_MODE },
    {
      path: "skills/swarm-worker/SKILL.md",
      content: renderWorkerSkill(args.skillTemplate, {
        agentName: args.config.agentName,
        email: args.config.email,
      }),
      mode: SHARED_FILE_MODE,
    },
    {
      path: "services.json",
      content: JSON.stringify(args.config.services, null, 2),
      mode: SHARED_FILE_MODE,
    },
    ...(args.serviceSkills ?? []).map((skill) => ({
      path: `skills/${skill.slug}/SKILL.md`,
      content: renderWorkerSkill(skill.content, {
        agentName: args.config.agentName,
        email: args.config.email,
      }),
      mode: SHARED_FILE_MODE,
    })),
  ];
}
