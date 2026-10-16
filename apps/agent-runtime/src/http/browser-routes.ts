import { Hono } from "hono";
import { z } from "zod";
import type { Run } from "@swarm/contracts";
import { browserTaskBlock, userRequestsBrowser } from "../browser/access-mode";
import { savedBrowserSlug } from "../browser/local-session";
import { credentialVariables, referencedVariables } from "../browser/secrets";
import { saveTokenFromPage } from "../browser/save-token";
import type { AgentRuntime } from "../runtime";
import { chatRetrySource } from "../tasks/chat";
import { noteActivity } from "../tasks/idle";
import { INSTRUCTION_ALIASES, SESSION_ALIASES, skyvernPurpose, withAliases } from "./lenient";

const BrowserOpen = z.object({
  runId: z.string(),
  purpose: z.string().optional(),
  serviceSlug: z.string().nullable().default(null),
  url: z.string().url().optional(),
});

const Session = z.object({ sessionId: z.string() });

/** Текст человека в этой задаче просит войти через браузер. Расписание сюда не входит. */
async function userAskedBrowser(rt: AgentRuntime, run: Run): Promise<boolean> {
  if (run.trigger === "chat" && run.threadId) {
    const messages = await rt.store.chats.listMessages(run.threadId, 500);
    const own = messages.filter((m) => m.runId === run.id && m.role === "user").map((m) => m.text);
    const source = chatRetrySource(messages, run.id);
    if ([...own, source ?? ""].some((text) => userRequestsBrowser(text))) return true;
  }
  if (run.trigger !== "email" && run.trigger !== "approval") return false;
  if (userRequestsBrowser(run.title)) return true;
  const steps = await rt.store.listSteps(run.id);
  if (steps.some((step) => step.data?.userBrowser === true)) return true;
  const chatId = await rt.chatIdForRun(run);
  const messages = await rt.store.chats.listMessages(chatId, 500);
  return messages.some((m) => m.runId === run.id && m.role === "user" && userRequestsBrowser(m.text));
}

async function browserBlock(
  rt: AgentRuntime,
  run: Run,
  args: { slug?: string | null; url?: string | null },
): Promise<string | null> {
  const blocked = browserTaskBlock(await rt.store.readServices(), args);
  if (!blocked || (await userAskedBrowser(rt, run))) return null;
  return blocked;
}

/** `%email%` и пароль из доступа сервиса. Модель видит только имена. */
async function sessionVariables(
  rt: AgentRuntime,
  serviceSlug: string | null,
  instruction: string,
): Promise<{ variables?: Record<string, string>; error?: { status: 400 | 409; message: string } }> {
  const used = referencedVariables(instruction);
  if (!used.length) return {};
  if (!serviceSlug) {
    return { error: { status: 400, message: "%email% и %password% работают только в сессии, открытой с serviceSlug сервиса" } };
  }
  const cred = (await rt.store.readServices())?.credentials.find((x) => x.slug === serviceSlug);
  const known = credentialVariables(cred);
  const missing = used.filter((v) => !known[v]);
  if (missing.length) {
    return { error: { status: 409, message: `в доступе ${serviceSlug} нет: ${missing.map((v) => `%${v}%`).join(", ")}` } };
  }
  return { variables: Object.fromEntries(used.map((v) => [v, known[v]!])) };
}

/** Hermes (соседний контейнер) → runtime: браузер Stagehand и Skyvern из скилла swarm-worker. */
export function browserRoutes(rt: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/browser/open", async (c) => {
    noteActivity();
    const body = BrowserOpen.parse(
      withAliases(await c.req.json(), {
        runId: ["run_id", "run"],
        purpose: ["goal", "task", "description", "reason", "prompt", "instruction"],
        serviceSlug: ["slug", "service", "service_slug"],
        url: ["startUrl", "start_url", "link"],
      }),
    );
    const run = await rt.store.getRun(body.runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    const blocked = await browserBlock(rt, run, { slug: body.serviceSlug, url: body.url ?? null });
    if (blocked) {
      await rt.step(run.id, "note", blocked);
      return c.json({ error: blocked }, 409);
    }
    const s = await rt.browser.open(run, {
      purpose: body.purpose?.trim() || (body.serviceSlug ? `работа в ${body.serviceSlug}` : "работа в браузере"),
      serviceSlug: body.serviceSlug,
      ...(body.url ? { url: body.url } : {}),
    });
    return c.json({ sessionId: s.id, liveUrl: s.meta.liveUrl });
  });

  app.post("/browser/goto", async (c) => {
    noteActivity();
    const body = Session.extend({ url: z.string().url() }).parse(withAliases(await c.req.json(), { ...SESSION_ALIASES, url: ["link", "href"] }));
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    const run = await rt.store.getRun(s.meta.runId);
    const blocked = run
      ? await browserBlock(rt, run, { slug: s.serviceSlug, url: body.url })
      : browserTaskBlock(await rt.store.readServices(), { slug: s.serviceSlug, url: body.url });
    if (blocked) return c.json({ error: blocked }, 409);
    await s.goto(body.url);
    return c.json({ ok: true, url: await s.currentUrl() });
  });

  // %email%, %password%, %name% в инструкции — значения из доступа сервиса этой сессии.
  // Модель секрет не видит: Stagehand вводит его сам.
  app.post("/browser/act", async (c) => {
    noteActivity();
    const body = Session.extend({ instruction: z.string() }).parse(withAliases(await c.req.json(), INSTRUCTION_ALIASES));
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    const prepared = await sessionVariables(rt, s.serviceSlug, body.instruction);
    if (prepared.error) return c.json({ error: prepared.error.message }, prepared.error.status);
    return c.json({ ...(await s.act(body.instruction, prepared.variables)), url: await s.currentUrl() });
  });

  // Вся цель одним вызовом: Stagehand сам делает несколько шагов, Hermes между ними не думает.
  app.post("/browser/goal", async (c) => {
    noteActivity();
    const body = Session.extend({
      instruction: z.string().min(1),
      maxSteps: z.number().int().min(1).max(12).default(6),
    }).parse(
      withAliases(await c.req.json(), {
        ...INSTRUCTION_ALIASES,
        maxSteps: ["max_steps", "steps", "limit"],
      }),
    );
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    const prepared = await sessionVariables(rt, s.serviceSlug, body.instruction);
    if (prepared.error) return c.json({ error: prepared.error.message }, prepared.error.status);
    const result = await s.goal(body.instruction, prepared.variables, body.maxSteps);
    await rt.step(s.meta.runId, "browser", `браузер: ${body.instruction.slice(0, 180)} (${result.steps} шагов)`);
    return c.json(result);
  });

  // Токен со страницы — сразу в доступ сервиса, рядом с почтой и паролем. Модели значение не отдаётся.
  app.post("/browser/save-token", async (c) => {
    noteActivity();
    const body = Session.parse(withAliases(await c.req.json(), SESSION_ALIASES));
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    if (!s.serviceSlug) return c.json({ error: "токен сохраняется только из сессии, открытой с serviceSlug сервиса" }, 400);
    const r = await saveTokenFromPage(rt, s);
    return c.json(r.body, r.status);
  });

  app.post("/browser/extract", async (c) => {
    noteActivity();
    const body = Session.extend({ instruction: z.string(), schema: z.unknown().optional() }).parse(
      withAliases(await c.req.json(), INSTRUCTION_ALIASES),
    );
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    return c.json({ data: await s.extract(body.instruction, body.schema) });
  });

  // Точный текст и поля без модели: ключи и токены символ в символ.
  app.post("/browser/read", async (c) => {
    noteActivity();
    const body = Session.parse(withAliases(await c.req.json(), SESSION_ALIASES));
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    return c.json(await s.read());
  });

  app.post("/browser/observe", async (c) => {
    noteActivity();
    const body = Session.extend({ instruction: z.string() }).parse(withAliases(await c.req.json(), INSTRUCTION_ALIASES));
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    return c.json({ data: await s.observe(body.instruction) });
  });

  app.post("/browser/wait-code", async (c) => {
    noteActivity();
    const body = Session.extend({ timeoutSec: z.number().int().min(10).max(900).default(300) }).parse(
      withAliases(await c.req.json(), { ...SESSION_ALIASES, timeoutSec: ["timeout", "timeout_sec", "seconds"] }),
    );
    const s = rt.browser.sessions.get(body.sessionId);
    if (!s) return c.json({ error: "session not found" }, 404);
    const got = await s.waitForCode(body.timeoutSec * 1000);
    return c.json(got ?? { kind: null, value: null, timedOut: true });
  });

  app.post("/browser/close", async (c) => {
    noteActivity();
    const body = Session.parse(withAliases(await c.req.json(), SESSION_ALIASES));
    await rt.browser.close(body.sessionId);
    return c.json({ ok: true });
  });

  app.post("/skyvern/login", async (c) => {
    noteActivity();
    if (!rt.skyvern) return c.json({ error: "SKYVERN_API_KEY не задан" }, 400);
    const raw = withAliases(await c.req.json(), {
      runId: ["run_id", "run"],
      url: ["loginUrl", "login_url", "link"],
      prompt: ["instruction", "task", "description", "goal"],
      credentials: ["credential", "auth"],
    });
    const body = z
      .object({
        runId: z.string(),
        url: z.string().url(),
        purpose: z.enum(["signup", "login"]),
        prompt: z.string().default("Войди по электронной почте и паролю из данных ниже."),
        credentials: z.record(z.string(), z.string()).default({}),
      })
      .parse({ ...raw, purpose: skyvernPurpose(raw.purpose, raw.url) });
    const run = await rt.store.getRun(body.runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    const services = await rt.store.readServices();
    const blocked = (await userAskedBrowser(rt, run)) ? null : browserTaskBlock(services, { url: body.url });
    if (blocked) {
      await rt.step(run.id, "note", blocked);
      return c.json({ error: blocked }, 409);
    }
    const saved = savedBrowserSlug(services, body.url);
    if (saved) {
      await rt.step(run.id, "note", `Skyvern не открываю: сессия ${saved} уже в своём браузере`);
      return c.json(
        {
          error: `Сессия «${saved}» уже в своём браузере. Задачу выполняй через POST /browser/open с serviceSlug "${saved}". Новый вход через Skyvern не нужен.`,
        },
        409,
      );
    }
    await rt.step(run.id, "browser", `skyvern ${body.purpose}: ${body.url}`);
    const r = await rt.skyvern.runLoginOrSignup({ ...body, onSession: (s) => rt.announceBrowser(run, s) });
    await rt.step(run.id, "browser", `skyvern ${body.purpose}: ${r.status}`, { sessionId: r.session.id });
    return c.json({ status: r.status, output: r.output, sessionId: r.session.id, hasVideo: r.session.hasVideo });
  });

  return app;
}
