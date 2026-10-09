import { request as httpRequest } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { loadConfig } from "./core/config";
import { describeZodError } from "./http/lenient";
import { applyBootstrap, clearGatewayRecords } from "./core/bootstrap";
import { AgentRuntime } from "./runtime";
import { resumeConnect } from "./onboarding";
import { startTicker } from "./tasks/cron";
import { startIdleWatch } from "./tasks/idle";
import { controlPlaneRoutes } from "./http/control-plane-routes";
import { proxyOpenRouter } from "./llm/openrouter-proxy";
import { ensureOpenRouterUsageProxy } from "./llm/hermes-config-sync";
import { browserRoutes } from "./http/browser-routes";
import { toolRoutes } from "./http/tool-routes";
import { log, warn } from "./core/log";

// Volume общий с Hermes (uid 10000). umask 077 оставлял services.json режимом 0600,
// Hermes не мог прочитать рецепт и пытался регистрировать MCP через hermes_tools.
process.umask(0o022);

const cfg = loadConfig();
const rt = new AgentRuntime(cfg);
rt.handoffs.useResume(resumeConnect);
await rt.init();
if (process.env.BOOTSTRAP_DIR) {
  await applyBootstrap(process.env.BOOTSTRAP_DIR, cfg.dataDir);
  await clearGatewayRecords(cfg.dataDir);
}
await ensureOpenRouterUsageProxy(cfg.dataDir);

const app = new Hono();

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice("Bearer ".length), "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

app.get("/health", (c) => c.json({ ok: true, agentId: cfg.agentId, busyInBrowser: rt.busyInBrowser }));

// Hermes ходит в OpenRouter через runtime, чтобы стоимость бралась из usage.cost ответа.
app.all("/openrouter/*", async (c) => {
  if (!bearerMatches(c.req.header("authorization"), cfg.openRouterApiKey)) return c.json({ error: "unauthorized" }, 401);
  return proxyOpenRouter(c.req.raw, rt.llmCosts);
});

app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  if (!bearerMatches(c.req.header("authorization"), cfg.runtimeToken)) return c.json({ error: "unauthorized" }, 401);
  return next();
});

app.onError(async (err, c) => {
  if (err instanceof ZodError) {
    // Hono кеширует разобранное тело — перечитать можно.
    const received = await c.req.json().catch(() => null);
    const described = describeZodError(err, received);
    warn("http", "неверное тело запроса", { path: c.req.path, issues: described.issues, received: described.received });
    return c.json(described, 400);
  }
  warn("http", "ошибка", { path: c.req.path, error: String(err) });
  return c.json({ error: String(err) }, 500);
});

app.route("/", controlPlaneRoutes(rt));
app.route("/", browserRoutes(rt));
app.route("/", toolRoutes(rt));

// На Fly тик приходит с control plane: свой таймер во сне не тикает.
if (!cfg.controlPlaneUrl) startTicker(rt, cfg.tickMinutes);
startIdleWatch(rt);

// Приватная сеть Fly (`.flycast` и старый `.internal`) — только IPv6. `0.0.0.0` снаружи недостижим,
// `::` слушает оба стека, 127.0.0.1 для healthcheck и Hermes тоже остаётся.
serve({ fetch: app.fetch, port: cfg.port, hostname: "::" }, () => {
  log("main", "runtime запущен", { port: cfg.port, agentId: cfg.agentId, email: cfg.email });
  watchListener(cfg.port);
});

/**
 * После suspend сокет остаётся закрытым, а процесс — живым: Fly не перезапускает
 * контейнер, пока тот сам не завершится. Отказ своего порта — сигнал выйти.
 */
function watchListener(port: number): void {
  setInterval(() => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/health", timeout: 2_000 }, (res) => {
      res.resume();
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "ECONNREFUSED") return;
      // #region agent log
      console.log(`[debug-105c57] port ${port} refused, exiting for restart`);
      // #endregion
      process.exit(1);
    });
    req.end();
  }, 10_000);
}
