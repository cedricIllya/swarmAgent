import type { Run, ServiceCredential, ServiceRecipe } from "@swarm/contracts";
import { parseAuthScheme } from "../onboarding/connect";
import { recordUsage } from "../core/usage";
import { warn } from "../core/log";
import type { AgentRuntime } from "../runtime";
import type { FoundTask } from "./found-tasks";
import {
  TASK_LIST_SCHEMA,
  mcpToolName,
  pageDigest,
  rememberTasksPage,
  saveWatch,
  savedTasksCall,
  splitTaskSurvey,
  tasksFromExtract,
  usesBrowser,
  type RememberedPage,
} from "./watch-page";

const PROTOCOL = "2025-06-18";

export interface WatchInput {
  service: string;
  method?: string | undefined;
  url?: string | undefined;
  body?: string | undefined;
  tool?: string | undefined;
  arguments?: Record<string, unknown> | undefined;
}

/**
 * Первый заход: браузер сохраняет адрес страницы, API и MCP — сам вызов.
 * Токен в вызов не входит.
 */
export async function rememberWatch(rt: AgentRuntime, run: Run, input: WatchInput): Promise<RememberedPage> {
  const services = await rt.store.readServices();
  const recipe = services?.recipes.find((item) => item.slug === input.service.trim());
  const cred = services?.credentials.find((item) => item.slug === input.service.trim());
  if (!services || !recipe || !cred) return { ok: false, status: 404, error: "сервис не подключён или не для задач" };
  if (usesBrowser(recipe, cred)) return rememberTasksPage(rt, run, input.service);
  return rememberTasksCall(rt, run, recipe, cred, input);
}

async function rememberTasksCall(
  rt: AgentRuntime,
  run: Run,
  recipe: ServiceRecipe,
  cred: ServiceCredential,
  input: WatchInput,
): Promise<RememberedPage> {
  const existing = savedTasksCall(recipe, cred);
  if (existing) return { ok: true, saved: false, tasks: [] };
  const draft = draftCall(recipe, cred, input);
  if (!draft) {
    return { ok: false, status: 409, error: "вызов списка не принят: нужен GET или POST на API сервиса, либо tool MCP, без токена в адресе" };
  }
  const reply = await replayCall(recipe, cred, draft);
  if (!reply.ok) return { ok: false, status: 409, error: `вызов списка не ответил (${reply.status}), он не сохранён` };
  const tasks = await parseTaskText(rt, run, recipe.slug, reply.text);
  if (!tasks) return { ok: false, status: 409, error: "ответ не разобран как список задач, вызов не сохранён" };
  await saveWatch(rt, run, cred, { tasksCall: draft, tasksDigest: reply.digest });
  await rt.step(run.id, draft.kind, `${recipe.name}: вызов списка запомнен`);
  return { ok: true, saved: true, tasks };
}

function methodOf(raw: string | undefined): "GET" | "POST" | null {
  if (!raw || raw.toUpperCase() === "GET") return "GET";
  if (raw.toUpperCase() === "POST") return "POST";
  return null;
}

function draftCall(recipe: ServiceRecipe, cred: ServiceCredential, input: WatchInput): ServiceCredential["tasksCall"] | null {
  if (input.tool) {
    const call = {
      kind: "mcp" as const,
      tool: mcpToolName(recipe.slug, input.tool),
      ...(input.arguments ? { arguments: input.arguments } : {}),
    };
    return savedTasksCall(recipe, { ...cred, tasksCall: call });
  }
  if (!input.url) return null;
  const method = methodOf(input.method);
  if (!method) return null;
  const call = {
    kind: "api" as const,
    method,
    url: input.url,
    ...(input.body && method === "POST" ? { body: input.body.slice(0, 4000) } : {}),
  };
  return savedTasksCall(recipe, { ...cred, tasksCall: call });
}

/** Повтор запомненных вызовов. Модель читает ответ только если он изменился. */
export async function surveySavedCalls(rt: AgentRuntime, run: Run, fetchImpl: typeof fetch = fetch): Promise<{ tasks: FoundTask[]; failed: number }> {
  const services = await rt.store.readServices();
  if (!services) return { tasks: [], failed: 0 };
  const tasks: FoundTask[] = [];
  let failed = 0;
  for (const item of splitTaskSurvey(services).calls) {
    if (await rt.isCanceled(run.id)) break;
    try {
      const found = await surveyCall(rt, run, item.recipe, item.cred, item.call, fetchImpl);
      tasks.push(...found);
    } catch (e) {
      failed += 1;
      warn("cron", "вызов списка не прочитан", { slug: item.recipe.slug, error: String(e) });
      await rt.step(run.id, "error", `${item.recipe.name}: список задач не прочитан`);
    }
  }
  return { tasks, failed };
}

async function surveyCall(
  rt: AgentRuntime,
  run: Run,
  recipe: ServiceRecipe,
  cred: ServiceCredential,
  call: NonNullable<ServiceCredential["tasksCall"]>,
  fetchImpl: typeof fetch,
): Promise<FoundTask[]> {
  const reply = await replayCall(recipe, cred, call, fetchImpl);
  if (!reply.ok) {
    await rt.step(run.id, "note", `${recipe.name}: список не прочитан (${reply.status}), вызов не меняю`);
    return [];
  }
  if (cred.tasksDigest === reply.digest) {
    await rt.step(run.id, "note", `${recipe.name}: список не изменился`);
    return [];
  }
  const tasks = await parseTaskText(rt, run, recipe.slug, reply.text);
  if (!tasks) {
    await rt.step(run.id, "note", `${recipe.name}: ответ списка не разобран`);
    return [];
  }
  await saveWatch(rt, run, cred, { tasksDigest: reply.digest });
  const n = tasks.length;
  await rt.step(run.id, call.kind, n ? `${recipe.name}: список задач, найдено ${n}` : `${recipe.name}: список задач пуст`);
  return tasks;
}

async function replayCall(
  recipe: ServiceRecipe,
  cred: ServiceCredential,
  call: NonNullable<ServiceCredential["tasksCall"]>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; text: string; digest: string }> {
  const token = cred.token || cred.oauth?.accessToken || null;
  const raw = call.kind === "mcp" ? await callMcp(recipe, token, call, fetchImpl) : await callApi(recipe, token, call, fetchImpl);
  const text = hideToken(raw.text, token);
  return { ok: raw.ok, status: raw.status, text, digest: pageDigest(text) };
}

async function callApi(
  recipe: ServiceRecipe,
  token: string | null,
  call: NonNullable<ServiceCredential["tasksCall"]>,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; text: string }> {
  if (!call.url || !token) return { ok: false, status: 401, text: "" };
  const headers: Record<string, string> = { Accept: "application/json", ...apiAuthHeaders(recipe, token) };
  const method = call.method ?? "GET";
  if (method === "POST" && call.body) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(call.url, {
    method,
    headers,
    ...(method === "POST" && call.body ? { body: call.body } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = (await res.text()).slice(0, 20_000);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
}

function apiAuthHeaders(recipe: ServiceRecipe, token: string): Record<string, string> {
  const parsed = parseAuthScheme(recipe.api?.authHeader || recipe.api?.auth || "Authorization");
  const name = parsed?.headerName ?? "Authorization";
  const scheme = parsed?.scheme ?? (recipe.api?.auth === "basic" ? "Basic" : recipe.api?.auth === "header" ? null : "Bearer");
  if (!scheme || name.toLowerCase() !== "authorization") return { [name]: token };
  const value = new RegExp(`^${scheme}\\s`, "i").test(token) ? token : `${scheme} ${token}`;
  return { Authorization: value };
}

async function callMcp(
  recipe: ServiceRecipe,
  token: string | null,
  call: NonNullable<ServiceCredential["tasksCall"]>,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; text: string }> {
  const url = recipe.mcp?.url;
  const tool = call.tool ? mcpToolName(recipe.slug, call.tool) : "";
  if (!url || !tool || (recipe.mcp?.auth !== "none" && !token)) return { ok: false, status: 401, text: "" };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
  };
  if (token && recipe.mcp?.auth !== "none") headers.Authorization = /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
  const init = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "swarm-agent", version: "0.1.0" } },
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const session = init.headers.get("mcp-session-id");
  await init.body?.cancel().catch(() => undefined);
  if (init.status === 401 || init.status === 403) return { ok: false, status: init.status, text: "" };
  if (session) headers["mcp-session-id"] = session;
  if (session) {
    await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
      .then((res) => res.body?.cancel())
      .catch(() => undefined);
  }
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: call.arguments ?? {} } }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = rpcText(await res.text(), res.headers.get("content-type") ?? "");
  return { ok: res.status >= 200 && res.status < 300 && !text.startsWith("ошибка MCP:"), status: res.status, text: text.slice(0, 20_000) };
}

function rpcText(raw: string, contentType: string): string {
  const payload = /event-stream/i.test(contentType)
    ? (raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== "[DONE]")
        .at(-1) ?? raw)
    : raw;
  try {
    const msg = JSON.parse(payload) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    if (msg.error?.message) return `ошибка MCP: ${msg.error.message}`;
    const parts = msg.result?.content?.map((item) => item.text).filter((item): item is string => Boolean(item));
    if (parts?.length) return parts.join("\n");
    return JSON.stringify(msg.result ?? msg);
  } catch {
    return raw;
  }
}

function hideToken(text: string, token: string | null): string {
  if (!token || token.length < 8) return text;
  return text.split(token).join("…");
}

async function parseTaskText(rt: AgentRuntime, run: Run, service: string, text: string): Promise<FoundTask[] | null> {
  if (!rt.openRouter) return null;
  const r = await rt.openRouter.chat(
    [
      {
        role: "user",
        content: [
          `Сервис ${service}. Ниже ответ списка задач.`,
          "Верни только задачи, назначенные текущему пользователю или упоминающие его.",
          "Нет таких — пустой список. title — название, detail — что сделать, key — ключ или ссылка. Не выдумывай.",
          "",
          text.slice(0, 12_000),
        ].join("\n"),
      },
    ],
    { jsonSchema: { name: "tasks", schema: TASK_LIST_SCHEMA }, temperature: 0, maxTokens: 800 },
    rt.model,
  );
  await recordUsage(rt.store, rt.taskRef(run), "tasks.extract", "runtime", r).catch((e) =>
    warn("cron", "расход разбора списка не записан", { error: String(e) }),
  );
  try {
    return tasksFromExtract(JSON.parse(r.text), service);
  } catch {
    return tasksFromExtract(r.text, service);
  }
}
