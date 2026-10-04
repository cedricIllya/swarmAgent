import { Hono } from "hono";
import { z } from "zod";
import type { AgentRuntime } from "../runtime";
import { noteActivity } from "../idle";

const BrowserOpen = z.object({
  runId: z.string(),
  purpose: z.string(),
  serviceSlug: z.string().nullable().default(null),
  url: z.string().url().optional(),
});

const Session = z.object({ sessionId: z.string() });

/** Hermes (соседний контейнер) → runtime: браузер Stagehand и Skyvern из скилла swarm-worker. */
export function browserRoutes(rt: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/browser/open", async (c) => {
    noteActivity();
    const body = BrowserOpen.parse(await c.req.json());
    const run = await rt.store.getRun(body.runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    const s = await rt.browser.open(run, {
      purpose: body.purpose,
      serviceSlug: body.serviceSlug,
      ...(body.url ? { url: body.url } : {}),
    });
    return c.json({ sessionId: s.id, liveUrl: s.meta.liveUrl });
  });

  app.post("/browser/goto", async (c) => {
    noteActivity();
    const body = Session.extend({ url: z.string().url() }).parse(await c.req.json());
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    await s.goto(body.url);
    return c.json({ ok: true, url: await s.currentUrl() });
  });

  app.post("/browser/act", async (c) => {
    noteActivity();
    const body = Session.extend({ instruction: z.string() }).parse(await c.req.json());
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    return c.json({ ...(await s.act(body.instruction)), url: await s.currentUrl() });
  });

  app.post("/browser/extract", async (c) => {
    noteActivity();
    const body = Session.extend({ instruction: z.string(), schema: z.unknown().optional() }).parse(await c.req.json());
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    return c.json({ data: await s.extract(body.instruction, body.schema) });
  });

  app.post("/browser/observe", async (c) => {
    noteActivity();
    const body = Session.extend({ instruction: z.string() }).parse(await c.req.json());
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    return c.json({ data: await s.observe(body.instruction) });
  });

  app.post("/browser/wait-code", async (c) => {
    noteActivity();
    const body = Session.extend({ timeoutSec: z.number().int().min(10).max(900).default(300) }).parse(await c.req.json());
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    const got = await s.waitForCode(body.timeoutSec * 1000);
    return c.json(got ?? { kind: null, value: null, timedOut: true });
  });

  app.post("/browser/close", async (c) => {
    noteActivity();
    const body = Session.parse(await c.req.json());
    await rt.browser.close(body.sessionId);
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
    const r = await rt.skyvern.runLoginOrSignup({ ...body, onSession: (s) => rt.announceBrowser(run, s) });
    await rt.step(run.id, "browser", `skyvern ${body.purpose}: ${r.status}`, { sessionId: r.session.id });
    return c.json({ status: r.status, output: r.output, sessionId: r.session.id, hasVideo: r.session.hasVideo });
  });

  return app;
}
