import { Hono } from "hono";
import type { AgentRuntime } from "../runtime";

const PROTOCOL = "2025-06-18";
const RESULT_MAX = 12_000;

interface ToolSpec {
  name: string;
  description: string;
  path: string | ((args: Record<string, unknown>) => string | null);
  inputSchema: Record<string, unknown>;
}

const str = { type: "string" };
const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

/**
 * Те же вызовы, что HTTP скилла. Hermes зовёт их как `mcp_swarm_runtime_*`
 * и не тратит ход на сборку curl.
 */
const TOOLS: ToolSpec[] = [
  {
    name: "browser_open",
    description: "Открыть свой Chromium. serviceSlug сохраняет cookies. Вернёт sessionId.",
    path: "/browser/open",
    inputSchema: obj(
      { runId: str, purpose: str, serviceSlug: { type: ["string", "null"] }, url: str },
      ["runId"],
    ),
  },
  {
    name: "browser_goal",
    description:
      "Несколько шагов к одной цели в уже открытой сессии. Для задачи в браузере вызывай это, а не цепочку browser_act. Вход с паролем — browser_act. Журнал задачи runtime пишет сам.",
    path: "/browser/goal",
    inputSchema: obj({ sessionId: str, instruction: str, maxSteps: { type: "integer" } }, ["sessionId", "instruction"]),
  },
  {
    name: "browser_act",
    description: "Один точный шаг. Вход: %email% и %password% в instruction, runtime подставит значения.",
    path: "/browser/act",
    inputSchema: obj({ sessionId: str, instruction: str }, ["sessionId", "instruction"]),
  },
  {
    name: "browser_extract",
    description: "Достать данные со страницы. Длинные токены так не читай — для них browser_read.",
    path: "/browser/extract",
    inputSchema: obj({ sessionId: str, instruction: str, schema: { type: "object" } }, ["sessionId", "instruction"]),
  },
  {
    name: "browser_observe",
    description: "Какие элементы есть на странице.",
    path: "/browser/observe",
    inputSchema: obj({ sessionId: str, instruction: str }, ["sessionId", "instruction"]),
  },
  {
    name: "browser_read",
    description: "Точный текст страницы и значения полей без модели. Так читают ключ и токен.",
    path: "/browser/read",
    inputSchema: obj({ sessionId: str }, ["sessionId"]),
  },
  {
    name: "browser_goto",
    description: "Открыть адрес в текущей сессии.",
    path: "/browser/goto",
    inputSchema: obj({ sessionId: str, url: str }, ["sessionId", "url"]),
  },
  {
    name: "browser_save_token",
    description: "Сохранить токен со страницы в доступ сервиса. Значение в ответ не попадает.",
    path: "/browser/save-token",
    inputSchema: obj({ sessionId: str }, ["sessionId"]),
  },
  {
    name: "browser_wait_code",
    description: "Ждать код или ссылку из письма. Не держи дольше нужного.",
    path: "/browser/wait-code",
    inputSchema: obj({ sessionId: str, timeoutSec: { type: "integer" } }, ["sessionId"]),
  },
  {
    name: "browser_close",
    description: "Закрыть сессию браузера.",
    path: "/browser/close",
    inputSchema: obj({ sessionId: str }, ["sessionId"]),
  },
  {
    name: "approval",
    description: "Спросить одобрение перед изменением в чужой системе. approved false — закончи ход.",
    path: "/approval",
    inputSchema: obj({ runId: str, description: str }, ["runId", "description"]),
  },
  {
    name: "ask",
    description: "Вопрос владельцу, без которого задачу не продолжить. После вызова закончи ход.",
    path: "/ask",
    inputSchema: obj({ runId: str, question: str, options: { type: "array", items: str } }, ["runId", "question"]),
  },
  {
    name: "report",
    description: "Записать рецепт сервиса или свой доступ. Секрет в текст ответа не копируй.",
    path: "/report",
    inputSchema: obj({ type: str, runId: str, recipe: { type: "object" }, credential: { type: "object" } }, ["type"]),
  },
  {
    name: "discover",
    description: "Найти способ входа в сервис, которого нет в каталоге.",
    path: "/discover",
    inputSchema: obj(
      { runId: str, service: { type: ["string", "null"] }, domain: { type: ["string", "null"] }, links: { type: "array", items: str } },
      ["runId"],
    ),
  },
  {
    name: "invite_accept",
    description: "Принять приглашение и зарегистрироваться в браузере. Только если runtime пишет, что шаг 0 не запускался.",
    path: "/invite/accept",
    inputSchema: obj({ runId: str, url: str, slug: str, service: str }, ["runId", "url", "slug", "service"]),
  },
  {
    name: "docs_fetch",
    description: "Прочитать страницу документации текстом.",
    path: "/docs/fetch",
    inputSchema: obj({ url: str, maxChars: { type: "integer" } }, ["url"]),
  },
  {
    name: "web_search",
    description: "Один поиск в интернете.",
    path: "/web/search",
    inputSchema: obj({ runId: str, query: str, maxResults: { type: "integer" } }, ["query"]),
  },
  {
    name: "email_send",
    description: "Письмо с адреса агента. Ответ человеку по задаче runtime шлёт сам.",
    path: "/email/send",
    inputSchema: obj({ runId: str, to: str, subject: str, text: str, inReplyTo: str }, ["runId", "to", "subject", "text"]),
  },
  {
    name: "tasks_found",
    description: "Задача, найденная плановой проверкой. Runtime начинает её отдельно.",
    path: "/tasks/found",
    inputSchema: obj({ runId: str, service: str, title: str, detail: str, key: str }, ["runId", "service", "title"]),
  },
  {
    name: "tasks_watch",
    description: "Запомнить список задач сервиса. Токен в вызов не клади.",
    path: "/tasks/watch",
    inputSchema: obj(
      {
        runId: str,
        service: str,
        method: str,
        url: str,
        body: { type: ["string", "object"] },
        tool: str,
        arguments: { type: "object" },
      },
      ["runId", "service"],
    ),
  },
  {
    name: "run_step",
    description: "Строка в журнал задачи. kind: mcp, api, browser, note или error.",
    path: (args) => (typeof args.runId === "string" && args.runId ? `/runs/${encodeURIComponent(args.runId)}/step` : null),
    inputSchema: obj(
      { runId: str, kind: str, text: str, data: { type: "object" } },
      ["runId", "text"],
    ),
  },
];

type Dispatch = (req: Request) => Promise<Response> | Response;

/** JSON-RPC MCP на том же порту, что и остальные вызовы runtime. */
export function mcpRoutes(rt: AgentRuntime, dispatch: Dispatch): Hono {
  const app = new Hono();

  app.post("/mcp", async (c) => {
    let message: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    try {
      message = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "не JSON" } }, 400);
    }
    const method = message.method ?? "";
    if (method.startsWith("notifications/") || message.id === undefined) return c.body(null, 202);

    if (method === "initialize") {
      c.header("mcp-session-id", "swarm");
      return c.json(
        rpc(message.id, {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "swarm-runtime", version: "0.1.0" },
        }),
      );
    }
    if (method === "ping") return c.json(rpc(message.id, {}));
    if (method === "tools/list") {
      return c.json(
        rpc(message.id, {
          tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        }),
      );
    }
    if (method === "tools/call") {
      const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const text = await callTool(rt, dispatch, params.name ?? "", params.arguments ?? {});
      return c.json(rpc(message.id, { content: [{ type: "text", text: text.body }], isError: text.error }));
    }
    return c.json(rpcError(message.id, -32601, `метод не поддерживается: ${method}`));
  });

  return app;
}

async function callTool(
  rt: AgentRuntime,
  dispatch: Dispatch,
  name: string,
  args: Record<string, unknown>,
): Promise<{ body: string; error: boolean }> {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return { body: `неизвестный инструмент: ${name}`, error: true };
  const path = typeof tool.path === "function" ? tool.path(args) : tool.path;
  if (!path) return { body: "нужен runId", error: true };
  const res = await dispatch(
    new Request(`http://127.0.0.1:${rt.cfg.port}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rt.cfg.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    }),
  );
  const text = (await res.text()).slice(0, RESULT_MAX);
  return { body: text || (res.ok ? "{}" : `пустой ответ ${res.status}`), error: !res.ok };
}

function rpc(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
