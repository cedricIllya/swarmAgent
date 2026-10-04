function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} не задан`);
  return v;
}

export interface RuntimeConfig {
  port: number;
  dataDir: string;
  agentId: string;
  agentName: string;
  email: string;
  ownerEmail: string | null;
  model: string;
  autonomous: boolean;
  runtimeToken: string;
  controlPlaneUrl: string;
  openRouterApiKey: string;
  hermesApiUrl: string;
  hermesApiKey: string;
  browserbase: { apiKey: string; projectId: string } | null;
  skyvernApiKey: string | null;
  tickMinutes: number;
}

export function loadConfig(): RuntimeConfig {
  const bbKey = process.env.BROWSERBASE_API_KEY;
  const bbProject = process.env.BROWSERBASE_PROJECT_ID;
  return {
    port: Number(process.env.PORT ?? 8787),
    dataDir: process.env.DATA_DIR ?? "/opt/data",
    agentId: need("AGENT_ID"),
    agentName: process.env.AGENT_NAME ?? "Agent",
    email: need("AGENT_EMAIL"),
    ownerEmail: process.env.OWNER_EMAIL ?? null,
    model: process.env.AGENT_MODEL ?? "openai/gpt-4.1-mini",
    autonomous: process.env.AGENT_AUTONOMOUS === "true",
    runtimeToken: need("RUNTIME_TOKEN"),
    controlPlaneUrl: process.env.CONTROL_PLANE_URL ?? "",
    openRouterApiKey: need("OPENROUTER_API_KEY"),
    hermesApiUrl: process.env.HERMES_API_URL ?? "http://127.0.0.1:8642/v1",
    hermesApiKey: process.env.HERMES_API_KEY ?? process.env.API_SERVER_KEY ?? "",
    browserbase: bbKey && bbProject ? { apiKey: bbKey, projectId: bbProject } : null,
    skyvernApiKey: process.env.SKYVERN_API_KEY ?? null,
    tickMinutes: Number(process.env.TICK_MINUTES ?? 15),
  };
}
