import { Hono } from "hono";
import { z } from "zod";
import { RuntimeReportSchema, type RuntimeReport, type ServiceCredential, type ServiceRecipe } from "@swarm/contracts";
import type { AgentRuntime } from "../runtime";
import { acceptFoundTask, CHECK_TITLE } from "../tasks/cron";
import { rememberWatch } from "../tasks/replay";
import { noteActivity } from "../tasks/idle";
import { redactInternal } from "../core/redact";
import { withAliases } from "./lenient";
import { guardCredentialReport, guardRecipeReport, mcpTokenCheck } from "../onboarding/report-guard";
import { browserTaskBlock } from "../browser/access-mode";
import { storedLoginAsked } from "../browser/secrets";

/**
 * Hermes (соседний контейнер) → runtime: инструменты скилла swarm-worker без браузера —
 * одобрения, рецепты, поиск сервиса и документации, почта, журнал задачи.
 */
export function toolRoutes(rt: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/approval", async (c) => {
    noteActivity();
    const body = z
      .object({ runId: z.string(), description: z.string().min(1) })
      .parse(withAliases(await c.req.json(), { runId: ["run_id", "run"], description: ["text", "reason", "action", "message"] }));
    const r = await rt.approvals.request(body.runId, body.description);
    return c.json({ approved: r.approved, pendingId: r.pending?.id ?? null });
  });

  app.post("/ask", async (c) => {
    noteActivity();
    const raw = withAliases(await c.req.json(), {
      runId: ["run_id", "run"],
      question: ["text", "prompt", "message", "description"],
      options: ["choices", "buttons"],
    });
    if (typeof raw.options === "string") {
      raw.options = raw.options
        .split(/\n+/)
        .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
        .filter(Boolean);
    }
    const body = z
      .object({
        runId: z.string(),
        question: z.string().min(1),
        options: z.array(z.string()).max(6).default([]),
      })
      .parse(raw);
    const services = await rt.store.readServices();
    const stored = storedLoginAsked(body.question, services);
    if (stored) {
      const viaApi = browserTaskBlock(services, { slug: stored });
      const error =
        viaApi ??
        `Пароль ${stored} уже сохранён в доступе — владельца не спрашивай. Открой POST /browser/open с serviceSlug "${stored}" (cookies уже там). Если просит войти — /browser/act с %email% и %password%: runtime введёт их сам. Токен со страницы сохраняй через POST /browser/save-token.`;
      await rt.step(
        body.runId,
        "note",
        viaApi ?? `вопрос о входе в ${stored} не задан: пароль уже в доступе`,
      );
      return c.json({ pending: false, error }, 409);
    }
    const r = await rt.approvals.ask(body.runId, body.question, body.options);
    return c.json({ pending: true, questionId: r.pendingId });
  });

  app.post("/report", async (c) => {
    noteActivity();
    const body = RuntimeReportSchema.parse(await c.req.json());
    const snap = await rt.store.readServices();
    const slug = body.type === "recipe" ? body.recipe.slug : body.credential.slug;
    const existing = snap?.recipes.find((r) => r.slug === slug) ?? null;
    const guard =
      body.type === "recipe"
        ? guardRecipeReport(existing, body.recipe)
        : await guardCredentialReport(existing, body.credential, (r, t) => mcpTokenCheck(r, t));
    if (!guard.ok) {
      const running = body.runId ? await rt.store.getRun(body.runId) : null;
      if (running) await rt.step(running.id, "note", `отчёт не принят: ${guard.reason}`);
      return c.json({ ok: false, error: guard.reason }, 422);
    }
    if (guard.note && body.runId) await rt.step(body.runId, "note", guard.note);
    const accepted: RuntimeReport =
      body.type === "recipe"
        ? { ...body, recipe: guard.value as ServiceRecipe }
        : { ...body, credential: guard.value as ServiceCredential };
    await rt.services.applyReport(accepted);
    return c.json({ ok: true, ...(guard.note ? { note: guard.note } : {}) });
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
      .parse(withAliases(await c.req.json(), { runId: ["run_id", "run"], text: ["body", "message", "content"], inReplyTo: ["in_reply_to"] }));
    const { runId, ...mail } = body;
    const { messageId } = await rt.controlPlane.sendEmail({ ...mail, text: redactInternal(mail.text) });
    await rt.store.rememberSent(messageId, { runId, to: mail.to, approvalId: null });
    await rt.step(runId, "email", `письмо отправлено ${mail.to}`, { messageId });
    return c.json({ messageId });
  });

  app.post("/tasks/found", async (c) => {
    noteActivity();
    const body = z
      .object({
        runId: z.string(),
        service: z.string().min(1),
        title: z.string().min(1),
        detail: z.string().default(""),
        key: z.string().optional(),
      })
      .parse(
        withAliases(await c.req.json(), {
          runId: ["run_id", "run"],
          service: ["slug", "serviceSlug"],
          title: ["name", "task"],
          detail: ["text", "description", "summary"],
          key: ["id", "issue", "url", "identifier"],
        }),
      );
    const result = await acceptFoundTask(rt, body.runId, {
      service: body.service,
      title: body.title,
      detail: body.detail,
      ...(body.key ? { key: body.key } : {}),
    });
    if (!result.ok) return c.json({ error: result.error }, result.error === "run not found" ? 404 : 409);
    return c.json({ started: result.started, runId: result.started ? result.runId : null, title: result.title });
  });

  app.post("/tasks/watch", async (c) => {
    noteActivity();
    const body = z
      .object({
        runId: z.string(),
        service: z.string().min(1),
        method: z.string().optional(),
        url: z.string().optional(),
        body: z.union([z.string().max(4000), z.record(z.string(), z.unknown())]).optional(),
        tool: z.string().max(120).optional(),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(
        withAliases(await c.req.json(), {
          runId: ["run_id", "run"],
          service: ["slug", "serviceSlug", "name"],
          method: ["http_method", "verb"],
          url: ["endpoint", "link"],
          tool: ["toolName", "tool_name"],
          arguments: ["args", "params", "input"],
        }),
      );
    const run = await rt.store.getRun(body.runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (run.title !== CHECK_TITLE || (run.status !== "running" && run.status !== "queued")) {
      return c.json({ error: "страница задач сохраняется только из плановой проверки" }, 409);
    }
    const payload = typeof body.body === "string" ? body.body : body.body ? JSON.stringify(body.body).slice(0, 4000) : undefined;
    const result = await rememberWatch(rt, run, {
      service: body.service,
      ...(body.method ? { method: body.method } : {}),
      ...(body.url ? { url: body.url } : {}),
      ...(payload ? { body: payload } : {}),
      ...(body.tool ? { tool: body.tool } : {}),
      ...(body.arguments ? { arguments: body.arguments } : {}),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    for (const task of result.tasks) await acceptFoundTask(rt, run.id, task);
    return c.json({ saved: result.saved, ...(result.url ? { url: result.url } : {}), tasks: result.tasks.length });
  });

  app.post("/runs/:id/step", async (c) => {
    noteActivity();
    const raw = withAliases(await c.req.json(), {
      kind: ["type", "step", "category"],
      text: ["message", "note", "description", "content", "summary", "step_text", "detail"],
      data: ["meta", "details"],
    });
    const body = z
      .object({
        kind: z.enum(["model", "tool", "mcp", "api", "browser", "email", "note", "error"]).catch("note"),
        text: z.string(),
        data: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(raw);
    await rt.step(c.req.param("id"), body.kind, redactInternal(body.text), body.data);
    return c.json({ ok: true });
  });

  return app;
}
