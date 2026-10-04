import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ChatRequestSchema,
  DeliverEmailRequestSchema,
  GoogleTokenRequestSchema,
  RuntimeReportSchema,
  SyncServicesRequestSchema,
  UpdateSettingsRequestSchema,
} from "@swarm/contracts";
import { loadConfig } from "./config";
import { applyBootstrap } from "./bootstrap";
import { AgentRuntime } from "./runtime";
import { processEmail } from "./inbox";
import { handleChat } from "./chat";
import { startTicker, tick } from "./cron";
import { streamRuntimeEvents } from "./events-http";
import { syncHermesMcp } from "./hermes-config-sync";
import { machineIsIdle, markSleepy, noteActivity, startIdleWatch } from "./idle";
import { log, warn } from "./log";
import { redactInternal } from "./redact";

// Volume общий с Hermes (uid 10000). umask 077 оставлял services.json режимом 0600,
// Hermes не мог прочитать рецепт и пытался регистрировать MCP через hermes_tools.
process.umask(0o022);

const cfg = loadConfig();
const rt = new AgentRuntime(cfg);
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

// Control plane → runtime

app.get("/state", async (c) => c.json(await rt.state()));

app.get("/events", (c) => streamRuntimeEvents(c, rt));

async function refreshHermesMcp(): Promise<void> {
  const snap = await rt.store.readServices();
  if (!snap) return;
  await syncHermesMcp(cfg.dataDir, snap, Boolean(cfg.skyvernApiKey));
  await rt.publishServices();
}

app.post("/email", async (c) => {
  noteActivity();
  const body = DeliverEmailRequestSchema.parse(await c.req.json());
  processEmail(rt, body.email).catch((e) => warn("inbox", "обработка упала", { error: String(e) }));
  return c.json({ accepted: true }, 202);
});

app.post("/chat", async (c) => {
  noteActivity();
  const body = ChatRequestSchema.parse(await c.req.json());
  const result = await handleChat(rt, { message: body.message, author: body.author, chatId: body.chatId });
  if (!result) return c.json({ error: "chat not found" }, 404);
  return c.json({ runId: result.run.id, chatId: result.chatId }, 202);
});

app.get("/chats", async (c) => c.json(await rt.store.listChats()));

app.post("/chats", async (c) => {
  noteActivity();
  const body = z.object({ title: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
  const chat = await rt.store.createChat(body.title?.trim() || "Новый чат");
  return c.json(chat, 201);
});

app.get("/chats/:id/messages", async (c) => {
  const chat = await rt.store.getChat(c.req.param("id"));
  if (!chat) return c.json({ error: "not found" }, 404);
  return c.json(await rt.store.listChatMessages(chat.id));
});

app.patch("/chats/:id", async (c) => {
  noteActivity();
  const body = z.object({ title: z.string().min(1).max(80) }).parse(await c.req.json());
  const chat = await rt.store.renameChat(c.req.param("id"), body.title);
  return chat ? c.json(chat) : c.json({ error: "not found" }, 404);
});

app.delete("/chats/:id", async (c) => {
  noteActivity();
  const ok = await rt.store.deleteChat(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

app.post("/settings", async (c) => {
  noteActivity();
  const body = UpdateSettingsRequestSchema.parse(await c.req.json());
  await rt.updateSettings(body);
  return c.json({ ok: true, model: rt.model, autonomous: rt.autonomous });
});

app.post("/services", async (c) => {
  noteActivity();
  const body = SyncServicesRequestSchema.parse(await c.req.json());
  await rt.store.writeServices(body.snapshot);
  await refreshHermesMcp();
  return c.json({ ok: true, recipes: body.snapshot.recipes.length, credentials: body.snapshot.credentials.length });
});

app.post("/google-token", async (c) => {
  noteActivity();
  const body = GoogleTokenRequestSchema.parse(await c.req.json());
  await rt.store.writeGoogleToken(body.token);
  return c.json({ ok: true });
});

app.post("/approvals/:id", async (c) => {
  noteActivity();
  const { approved } = z.object({ approved: z.boolean() }).parse(await c.req.json());
  const run = await rt.resolveApproval(c.req.param("id"), approved);
  return run ? c.json({ runId: run.id, status: run.status }) : c.json({ error: "not found" }, 404);
});

app.post("/tick", async (c) => {
  const started = Date.now();
  const result = await tick(rt);
  if (await machineIsIdle(rt)) markSleepy(started);
  return c.json(result);
});

app.get("/runs/:id", async (c) => {
  const run = await rt.store.getRun(c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  return c.json({ run, steps: await rt.store.listSteps(run.id) });
});

app.get("/browser-sessions/:id/actions", async (c) => c.json(await rt.store.browserActions(c.req.param("id"))));

app.get("/browser-sessions/:id/video", async (c) => {
  const id = c.req.param("id");
  if (!(await rt.store.hasVideo(id))) return c.json({ error: "no video" }, 404);
  const stream = Readable.toWeb(createReadStream(rt.store.videoPath(id))) as ReadableStream;
  return new Response(stream, { headers: { "Content-Type": "video/mp4" } });
});

// Hermes (соседний контейнер) → runtime. Это инструменты скилла swarm-worker.

const BrowserOpen = z.object({
  runId: z.string(),
  purpose: z.string(),
  serviceSlug: z.string().nullable().default(null),
  url: z.string().url().optional(),
});

app.post("/browser/open", async (c) => {
  noteActivity();
  const body = BrowserOpen.parse(await c.req.json());
  const run = await rt.store.getRun(body.runId);
  if (!run) return c.json({ error: "run not found" }, 404);
  const s = await rt.openBrowser(run, {
    purpose: body.purpose,
    serviceSlug: body.serviceSlug,
    ...(body.url ? { url: body.url } : {}),
  });
  return c.json({ sessionId: s.id });
});

const Session = z.object({ sessionId: z.string() });

app.post("/browser/goto", async (c) => {
  noteActivity();
  const body = Session.extend({ url: z.string().url() }).parse(await c.req.json());
  const s = rt.sessions.get(body.sessionId);
  if (!s) return c.json({ error: "session not found" }, 404);
  await s.goto(body.url);
  return c.json({ ok: true, url: await s.currentUrl() });
});

app.post("/browser/act", async (c) => {
  noteActivity();
  const body = Session.extend({ instruction: z.string() }).parse(await c.req.json());
  const s = rt.sessions.get(body.sessionId);
  if (!s) return c.json({ error: "session not found" }, 404);
  return c.json({ ...(await s.act(body.instruction)), url: await s.currentUrl() });
});

app.post("/browser/extract", async (c) => {
  noteActivity();
  const body = Session.extend({ instruction: z.string(), schema: z.unknown().optional() }).parse(await c.req.json());
  const s = rt.sessions.get(body.sessionId);
  if (!s) return c.json({ error: "session not found" }, 404);
  return c.json({ data: await s.extract(body.instruction, body.schema) });
});

app.post("/browser/observe", async (c) => {
  noteActivity();
  const body = Session.extend({ instruction: z.string() }).parse(await c.req.json());
  const s = rt.sessions.get(body.sessionId);
  if (!s) return c.json({ error: "session not found" }, 404);
  return c.json({ data: await s.observe(body.instruction) });
});

app.post("/browser/wait-code", async (c) => {
  noteActivity();
  const body = Session.extend({ timeoutSec: z.number().int().min(10).max(900).default(300) }).parse(await c.req.json());
  const s = rt.sessions.get(body.sessionId);
  if (!s) return c.json({ error: "session not found" }, 404);
  const got = await s.waitForCode(body.timeoutSec * 1000);
  return c.json(got ?? { kind: null, value: null, timedOut: true });
});

app.post("/browser/close", async (c) => {
  noteActivity();
  const body = Session.parse(await c.req.json());
  await rt.closeBrowser(body.sessionId);
  return c.json({ ok: true });
});

app.post("/skyvern/login", async (c) => {
  noteActivity();
  if (!rt.skyvern) return c.json({ error: "SKYVERN_API_KEY не задан" }, 400);
  const body = z
    .object({
      runId: z.string(),
      url: z.string().url(),
      purpose: z.enum(["signup", "login"]),
      prompt: z.string(),
      credentials: z.record(z.string(), z.string()).default({}),
    })
    .parse(await c.req.json());
  const run = await rt.store.getRun(body.runId);
  if (!run) return c.json({ error: "run not found" }, 404);
  await rt.step(run.id, "browser", `skyvern ${body.purpose}: ${body.url}`);
  const r = await rt.skyvern.runLoginOrSignup(body);
  return c.json({ status: r.status, output: r.output, sessionId: r.session.id, hasVideo: r.session.hasVideo });
});

app.post("/approval", async (c) => {
  noteActivity();
  const body = z.object({ runId: z.string(), description: z.string().min(1) }).parse(await c.req.json());
  const r = await rt.requestApproval(body.runId, body.description);
  return c.json({ approved: r.approved, pendingId: r.pending?.id ?? null });
});

app.post("/report", async (c) => {
  noteActivity();
  const body = RuntimeReportSchema.parse(await c.req.json());
  await rt.controlPlane.report(body);
  const snap = await rt.store.readServices();
  const reported =
    body.type === "recipe"
      ? { name: body.recipe.name, kind: body.recipe.kind, slug: body.recipe.slug }
      : { name: body.credential.slug, kind: body.credential.kind, slug: body.credential.slug };
  if (snap) {
    if (body.type === "recipe") {
      snap.recipes = [...snap.recipes.filter((r) => r.slug !== body.recipe.slug), body.recipe];
    } else {
      snap.credentials = [...snap.credentials.filter((r) => r.slug !== body.credential.slug), body.credential];
    }
    await rt.store.writeServices(snap);
    await refreshHermesMcp();
  }
  const kindLabel = { mcp: "MCP", api: "API", browser: "браузер" } as const;
  const running = body.runId
    ? await rt.store.getRun(body.runId)
    : (await rt.store.listRuns(20)).find((r) => r.status === "running");
  if (running) {
    await rt.step(running.id, "note", `подключён сервис ${reported.name} (${kindLabel[reported.kind]})`);
  }
  return c.json({ ok: true });
});

app.post("/email/send", async (c) => {
  noteActivity();
  const body = z
    .object({ runId: z.string(), to: z.string(), subject: z.string(), text: z.string(), inReplyTo: z.string().optional() })
    .parse(await c.req.json());
  const { runId, ...mail } = body;
  const { messageId } = await rt.controlPlane.sendEmail({ ...mail, text: redactInternal(mail.text) });
  await rt.store.rememberSent(messageId, { runId, to: mail.to, approvalId: null });
  await rt.step(runId, "email", `письмо отправлено ${mail.to}`, { messageId });
  return c.json({ messageId });
});

app.post("/runs/:id/step", async (c) => {
  noteActivity();
  const body = z
    .object({
      kind: z.enum(["model", "tool", "mcp", "api", "browser", "email", "note", "error"]),
      text: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await c.req.json());
  await rt.step(c.req.param("id"), body.kind, redactInternal(body.text), body.data);
  return c.json({ ok: true });
});

// На Fly тик приходит с control plane: свой таймер во сне не тикает.
if (!cfg.controlPlaneUrl) startTicker(rt, cfg.tickMinutes);
startIdleWatch(rt);

// Приватная сеть Fly (`.flycast` и старый `.internal`) — только IPv6. `0.0.0.0` снаружи недостижим,
// `::` слушает оба стека, 127.0.0.1 для healthcheck и Hermes тоже остаётся.
serve({ fetch: app.fetch, port: cfg.port, hostname: "::" }, () => {
  log("main", "runtime запущен", { port: cfg.port, agentId: cfg.agentId, email: cfg.email });
});
