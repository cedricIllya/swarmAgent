import { Hono } from "hono";
import { z } from "zod";
import { RuntimeReportSchema } from "@swarm/contracts";
import type { AgentRuntime } from "../runtime";
import { noteActivity } from "../idle";
import { redactInternal } from "../redact";

/**
 * Hermes (соседний контейнер) → runtime: инструменты скилла swarm-worker без браузера —
 * одобрения, рецепты, поиск сервиса и документации, почта, журнал задачи.
 */
export function toolRoutes(rt: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/approval", async (c) => {
    noteActivity();
    const body = z.object({ runId: z.string(), description: z.string().min(1) }).parse(await c.req.json());
    const r = await rt.approvals.request(body.runId, body.description);
    return c.json({ approved: r.approved, pendingId: r.pending?.id ?? null });
  });

  app.post("/report", async (c) => {
    noteActivity();
    const body = RuntimeReportSchema.parse(await c.req.json());
    await rt.services.applyReport(body);
    return c.json({ ok: true });
  });

  // Поиск способа входа в сервис, которого нет в каталоге: реестр MCP, типовые адреса,
  // документация в интернете. Подтверждённый MCP записывается рецептом сам.
  app.post("/discover", async (c) => {
    noteActivity();
    const body = z
      .object({
        runId: z.string(),
        service: z.string().nullable().default(null),
        domain: z.string().nullable().default(null),
        links: z.array(z.string()).default([]),
      })
      .parse(await c.req.json());
    const run = await rt.store.getRun(body.runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    const known = await rt.services.knownRecipe([...body.links, body.domain ?? ""]);
    if (known) return c.json({ known: { slug: known.slug, name: known.name, kind: known.kind }, result: null });
    const result = await rt.research.discover(run, { service: body.service, domain: body.domain, links: body.links });
    return c.json({ known: null, result });
  });

  // Принять приглашение и зарегистрироваться под почтой агента — всегда в браузере:
  // Skyvern (коды из писем runtime передаёт ему сам), иначе свой Chromium.
  app.post("/invite/accept", async (c) => {
    noteActivity();
    const body = z
      .object({ runId: z.string(), url: z.string().url(), slug: z.string().min(1), service: z.string().min(1) })
      .parse(await c.req.json());
    const run = await rt.store.getRun(body.runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    const r = await rt.browser.acceptInvite(run, { url: body.url, slug: body.slug, service: body.service });
    const { password: _password, ...safe } = r;
    return c.json({ ...safe, passwordSaved: r.password !== null });
  });

  app.post("/docs/fetch", async (c) => {
    noteActivity();
    const body = z
      .object({ url: z.string().url(), maxChars: z.number().int().min(500).max(60_000).default(20_000) })
      .parse(await c.req.json());
    const page = await rt.research.readDocs(body.url, body.maxChars);
    if (!page) return c.json({ error: "страница недоступна" }, 502);
    return c.json(page);
  });

  app.post("/web/search", async (c) => {
    noteActivity();
    const body = z
      .object({ runId: z.string().optional(), query: z.string().min(2), maxResults: z.number().int().min(1).max(10).default(6) })
      .parse(await c.req.json());
    const run = body.runId ? await rt.store.getRun(body.runId) : null;
    const task = run ? rt.taskRef(run) : { taskId: "web", taskTitle: "Поиск в интернете" };
    const r = await rt.research.webSearch(body.query, task, body.maxResults);
    if (run) await rt.step(run.id, "tool", `поиск в интернете: ${body.query.slice(0, 120)}`, { results: r.results.length });
    return c.json(r);
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

  return app;
}
