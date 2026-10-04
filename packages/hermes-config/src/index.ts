import type { ServicesSnapshot } from "@swarm/contracts";
import { stringify } from "yaml";

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
 * `config.yaml` Hermes: провайдер OpenRouter, модель агента, MCP-серверы из
 * общего каталога с секретами тенанта. Skyvern — единственный MCP «из коробки».
 */
export function renderConfigYaml(input: HermesConfigInput): string {
  const mcpServers: Record<string, unknown> = {};

  if (input.skyvern.enabled) {
    mcpServers["skyvern"] = {
      command: "skyvern",
      args: ["run", "mcp"],
      env: { SKYVERN_API_KEY: "${SKYVERN_API_KEY}" },
      description: "Регистрация и вход в сервисы через браузер. Только для signup/login.",
    };
  }

  for (const recipe of input.services.recipes) {
    if (recipe.kind !== "mcp" || !recipe.mcp) continue;
    const cred = input.services.credentials.find((c) => c.slug === recipe.slug);
    const headers: Record<string, string> = {};
    const token = cred?.token ?? cred?.oauth?.accessToken;
    if (recipe.mcp.auth !== "none" && token) headers["Authorization"] = `Bearer ${token}`;
    const entry: Record<string, unknown> = {
      url: recipe.mcp.url,
      transport: recipe.mcp.transport,
    };
    if (Object.keys(headers).length) entry["headers"] = headers;
    if (recipe.mcp.includeTools.length) entry["include_tools"] = recipe.mcp.includeTools;
    if (recipe.notes) entry["description"] = recipe.notes.slice(0, 300);
    mcpServers[recipe.slug] = entry;
  }

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
    mcp_servers: mcpServers,
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
  browserbaseApiKey?: string | undefined;
  browserbaseProjectId?: string | undefined;
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
  if (input.browserbaseApiKey) lines.push(`BROWSERBASE_API_KEY=${input.browserbaseApiKey}`);
  if (input.browserbaseProjectId) lines.push(`BROWSERBASE_PROJECT_ID=${input.browserbaseProjectId}`);
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

/** Все файлы, которые control plane кладёт на volume при создании и смене настроек. */
export function renderAllFiles(args: {
  config: HermesConfigInput;
  env: HermesEnvInput;
  skillTemplate: string;
}): RenderedFile[] {
  return [
    { path: "config.yaml", content: renderConfigYaml(args.config) },
    { path: ".env", content: renderHermesEnv(args.env), mode: "0600" },
    { path: "cron/jobs.json", content: renderCronJobs() },
    {
      path: "skills/swarm-worker/SKILL.md",
      content: renderWorkerSkill(args.skillTemplate, {
        agentName: args.config.agentName,
        email: args.config.email,
      }),
    },
    { path: "services.json", content: JSON.stringify(args.config.services, null, 2), mode: "0600" },
  ];
}
