import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config";
import { applyBootstrap } from "./bootstrap";
import { AgentRuntime } from "./runtime";
import { resumeConnect } from "./onboarding";
import { startTicker } from "./cron";
import { startIdleWatch } from "./idle";
import { controlPlaneRoutes } from "./http/control-plane-routes";
import { browserRoutes } from "./http/browser-routes";
import { toolRoutes } from "./http/tool-routes";
import { log, warn } from "./log";

// Volume общий с Hermes (uid 10000). umask 077 оставлял services.json режимом 0600,
// Hermes не мог прочитать рецепт и пытался регистрировать MCP через hermes_tools.
process.umask(0o022);

const cfg = loadConfig();
const rt = new AgentRuntime(cfg);
rt.handoffs.useResume(resumeConnect);
await rt.init();
if (process.env.BOOTSTRAP_DIR) await applyBootstrap(process.env.BOOTSTRAP_DIR, cfg.dataDir);

const app = new Hono();

function tokenOk(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7), "utf8");
  const b = Buffer.from(cfg.runtimeToken, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

app.get("/health", (c) => c.json({ ok: true, agentId: cfg.agentId, busyInBrowser: rt.busyInBrowser }));

app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  if (!tokenOk(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  return next();
});

app.onError((err, c) => {
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
});
