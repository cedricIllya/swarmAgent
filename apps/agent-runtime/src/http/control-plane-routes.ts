import { Hono } from "hono";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  ChatRequestSchema,
  DeliverEmailRequestSchema,
  GoogleTokenRequestSchema,
  SyncServicesRequestSchema,
  UpdateSettingsRequestSchema,
} from "@swarm/contracts";
import type { AgentRuntime } from "../runtime";
import { processEmail } from "../inbox";
import { handleChat, retryChatRun } from "../chat";
import { tick } from "../cron";
import { streamRuntimeEvents } from "../events-http";
import { machineIsIdle, markSleepy, noteActivity } from "../idle";
import { warn } from "../log";

/** Control plane → runtime: состояние, почта, чаты, настройки, одобрения, тик. */
export function controlPlaneRoutes(rt: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/state", async (c) => c.json(await rt.state()));

  app.get("/events", (c) => streamRuntimeEvents(c, rt));

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

  app.get("/chats", async (c) => c.json(await rt.store.chats.list()));

  app.post("/chats", async (c) => {
    noteActivity();
    const body = z.object({ title: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const chat = await rt.store.chats.create(body.title?.trim() || "Новый чат");
    return c.json(chat, 201);
  });

  app.post("/chats/:id/retry", async (c) => {
    noteActivity();
    const body = z.object({ runId: z.string().min(1), author: z.string().min(1) }).parse(await c.req.json());
    const result = await retryChatRun(rt, { chatId: c.req.param("id"), runId: body.runId, author: body.author });
    if ("error" in result) return c.json({ error: result.error === "busy" ? "busy" : "not found" }, result.error === "busy" ? 409 : 404);
    return c.json({ runId: result.run.id, chatId: result.chatId }, 202);
  });

  app.get("/chats/:id/messages", async (c) => {
    const chat = await rt.store.chats.get(c.req.param("id"));
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json(await rt.store.chats.listMessages(chat.id));
  });

  app.patch("/chats/:id", async (c) => {
    noteActivity();
    const body = z.object({ title: z.string().min(1).max(80) }).parse(await c.req.json());
    const chat = await rt.store.chats.rename(c.req.param("id"), body.title);
    return chat ? c.json(chat) : c.json({ error: "not found" }, 404);
  });

  app.delete("/chats/:id", async (c) => {
    noteActivity();
    const ok = await rt.store.chats.remove(c.req.param("id"));
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
    const prev = await rt.store.readServices();
    await rt.store.writeServices(body.snapshot);
    await rt.services.dropRemoved(prev, body.snapshot);
    await rt.services.refreshHermesMcp();
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
    const body = z
      .object({ approved: z.boolean().optional(), answer: z.string().max(8000).optional() })
      .parse(await c.req.json());
    const answer = body.answer?.trim() ?? "";
    if (!answer && typeof body.approved !== "boolean") return c.json({ error: "bad input" }, 400);
    const run = await rt.approvals.resolve(c.req.param("id"), body.approved ?? true, answer ? { answer } : undefined);
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

  app.post("/runs/:id/cancel", async (c) => {
    noteActivity();
    const run = await rt.cancelRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    if (run.status !== "canceled") {
      return c.json({ error: "not cancelable", run }, 409);
    }
    return c.json({ runId: run.id, status: run.status });
  });

  app.get("/browser-sessions/:id/actions", async (c) => c.json(await rt.store.browserActions(c.req.param("id"))));

  app.get("/browser-sessions/:id/shots/:file", async (c) => {
    const file = rt.store.shotPath(c.req.param("id"), c.req.param("file"));
    if (!file || !existsSync(file)) return c.json({ error: "no screenshot" }, 404);
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(stream, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
  });

  app.get("/browser-sessions/:id/video", async (c) => {
    const id = c.req.param("id");
    if (!(await rt.store.hasVideo(id))) return c.json({ error: "no video" }, 404);
    const stream = Readable.toWeb(createReadStream(rt.store.videoPath(id))) as ReadableStream;
    return new Response(stream, { headers: { "Content-Type": "video/mp4" } });
  });

  return app;
}
