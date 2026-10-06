import { describe, expect, it, vi } from "vitest";
import type { Run, ServiceRecipe, ServicesSnapshot } from "@swarm/contracts";
import type { OpenRouterClient } from "../../src/llm/openrouter";
import {
  appendWorkGuide,
  ensureWorkGuides,
  formatWorkGuide,
  hasWorkGuide,
  NO_TASKS_GUIDE,
  helpFallbackUrls,
  learnWorkGuide,
  pickHelpUrls,
  scoreHelpUrl,
  type WorkGuideHost,
} from "../../src/onboarding/service-guide";

const guideJson = JSON.stringify({
  watchesTasks: true,
  objects: "доска и карточка",
  myWork: "меню слева, «Мои карточки»",
  actions: "открыть карточку, перенести в другой список, написать комментарий",
  avoid: "оплата, участники доски, удаление доски",
});

describe("work guide text", () => {
  it("keeps a short map and does not write an empty one", () => {
    const text = formatWorkGuide({
      watchesTasks: true,
      objects: "доска и карточка",
      myWork: "«Мои карточки» слева",
      actions: "открыть, перенести",
      avoid: "оплата",
    });
    expect(text).toMatch(/^Как работать:/);
    expect(text).toContain("Назначенное мне");
    expect(text).toContain("Не трогать");
    expect(formatWorkGuide({ watchesTasks: true, objects: "", myWork: "  ", actions: "открыть", avoid: "" })).toBeNull();
    expect(formatWorkGuide({ watchesTasks: false, objects: "", myWork: "", actions: "", avoid: "" })).toBe(NO_TASKS_GUIDE);
    expect(formatWorkGuide({ watchesTasks: null, objects: "доска", myWork: "входящие", actions: "", avoid: "" })).toBeNull();
    expect(hasWorkGuide("Вход по паролю. Как работать: объекты — доска.")).toBe(true);
  });

  it("appends the map to the connection note and does not duplicate it", () => {
    const guide = "Как работать: объекты — доска. Назначенное мне — входящие.";
    const once = appendWorkGuide("Вход по паролю.", guide);
    expect(once).toBe(`Вход по паролю. ${guide}`);
    expect(appendWorkGuide(once, "Как работать: другое")).toBe(once);
  });
});

describe("help pages", () => {
  it("prefers a getting-started page of this service over API docs and other sites", () => {
    expect(scoreHelpUrl("https://help.trello.com/article/getting-started")).toBe(80);
    expect(scoreHelpUrl("https://developer.trello.com/docs/api/tokens")).toBe(0);
    expect(scoreHelpUrl("https://help.trello.com/img/board.png")).toBe(0);
    const urls = pickHelpUrls(
      [
        { url: "https://developer.trello.com/docs/api/tokens" },
        { url: "https://help.trello.com/help/my-cards" },
        { url: "https://evil.example/help/tasks" },
        { url: "https://trello.zendesk.com/hc/en-us/articles/getting-started" },
      ],
      "trello.com",
    );
    expect(urls[0]).toBe("https://trello.zendesk.com/hc/en-us/articles/getting-started");
    expect(urls).toContain("https://help.trello.com/help/my-cards");
    expect(urls).not.toContain("https://evil.example/help/tasks");
    expect(helpFallbackUrls("trello.com")).toContain("https://help.trello.com/");
  });
});

describe("learnWorkGuide", () => {
  it("reads a help page and returns a map", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("<html><title>Мои карточки</title><body><p>Карточки, назначенные вам, лежат в меню слева. Откройте карточку, чтобы сменить список или написать комментарий.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const chat = vi.fn(async (_m: unknown, opts: { webSearch?: unknown }) => ({
      text: opts.webSearch ? "см. справку" : guideJson,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: opts.webSearch ? [{ url: "https://help.trello.com/article/my-cards", title: "Мои карточки", content: "назначенные карточки" }] : [],
    }));
    const outcome = await learnWorkGuide("Trello", "trello.com", {
      openRouter: { chat } as unknown as OpenRouterClient,
      model: "m",
      fetchImpl,
    });
    expect(outcome).toMatchObject({ status: "ready" });
    if (outcome.status === "ready") expect(outcome.text).toContain("Мои карточки");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("does not search when the model client is missing", async () => {
    expect(await learnWorkGuide("Trello", "trello.com", { openRouter: null, model: "m" })).toEqual({ status: "skipped" });
  });
});

function recipe(partial: Partial<ServiceRecipe> & Pick<ServiceRecipe, "slug" | "kind">): ServiceRecipe {
  return {
    name: partial.slug,
    domains: ["trello.com"],
    notes: "",
    discoveredBy: null,
    ...partial,
  };
}

describe("ensureWorkGuides", () => {
  it("classifies every connected service and writes a map where tasks exist", async () => {
    const snap: ServicesSnapshot = {
      generatedAt: "t",
      recipes: [
        recipe({ slug: "trello", name: "Trello", kind: "browser", notes: "Вход по паролю." }),
        recipe({ slug: "linear", name: "Linear", kind: "mcp", domains: ["linear.app"] }),
      ],
      credentials: [
        { slug: "trello", kind: "browser", password: "pw" },
        { slug: "linear", kind: "mcp", token: "lin_123" },
      ],
    };
    const saved: ServiceRecipe[] = [];
    const notes: string[] = [];
    const chat = vi.fn(async (_m: unknown, opts: { webSearch?: unknown }) => ({
      text: opts.webSearch ? "справка" : guideJson,
      promptTokens: 2,
      completionTokens: 2,
      costUsd: 0.01,
      model: "m",
      citations: opts.webSearch ? [{ url: "https://help.trello.com/article/getting-started", title: "Start", content: "доски и карточки, назначенные вам" }] : [],
    }));
    const fetchImpl = vi.fn(async () => {
      return new Response("<html><title>Start</title><body><p>Доски состоят из карточек. Назначенные вам карточки лежат в меню слева, их можно открыть и перенести в другой список.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const host = {
      model: "m",
      openRouter: { chat } as unknown as OpenRouterClient,
      store: {
        readServices: async () => snap,
        addUsage: vi.fn(),
      },
      services: {
        applyReport: async (input: { type: string; recipe?: ServiceRecipe }) => {
          if (input.type === "recipe" && input.recipe) saved.push(input.recipe);
        },
      },
      step: async (_id: string, _kind: "note", text: string) => {
        notes.push(text);
      },
      taskRef: () => ({ taskId: "run-1", taskTitle: "Задача" }),
    } as unknown as WorkGuideHost;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await ensureWorkGuides(host, { id: "run-1" } as Run);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(saved.map((r) => r.slug).sort()).toEqual(["linear", "trello"]);
    const trello = saved.find((r) => r.slug === "trello");
    expect(trello?.notes).toMatch(/^Вход по паролю\. Как работать:/);
    expect(trello?.watchesTasks).toBe(true);
    expect(saved.find((r) => r.slug === "linear")?.watchesTasks).toBe(true);
    expect(notes[0]).toMatch(/как работать в Trello/);
    expect(chat.mock.calls.length).toBe(4);

    await ensureWorkGuides(host, { id: "run-1" } as Run);
    expect(saved).toHaveLength(2);
  });

  it("marks a service without assigned work and does not ask to browse it", async () => {
    const snap: ServicesSnapshot = {
      generatedAt: "t",
      recipes: [recipe({ slug: "stripe", name: "Stripe", kind: "api", domains: ["stripe.com"], notes: "Ключ в кабинете." })],
      credentials: [{ slug: "stripe", kind: "api", token: "sk_test" }],
    };
    const saved: ServiceRecipe[] = [];
    const chat = vi.fn(async (_m: unknown, opts: { webSearch?: unknown }) => ({
      text: opts.webSearch
        ? "справка"
        : JSON.stringify({ watchesTasks: false, objects: "", myWork: "", actions: "", avoid: "оплата" }),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: opts.webSearch
        ? [{ url: "https://docs.stripe.com/get-started", title: "Start", content: "платежи и ключи API" }]
        : [],
    }));
    const fetchImpl = vi.fn(async () => {
      return new Response("<html><title>Start</title><body><p>Stripe принимает платежи. Ключ API создаётся в кабинете. Назначенных задач у пользователя нет.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const host = {
      model: "m",
      openRouter: { chat } as unknown as OpenRouterClient,
      store: { readServices: async () => snap, addUsage: vi.fn() },
      services: {
        applyReport: async (input: { type: string; recipe?: ServiceRecipe }) => {
          if (input.type === "recipe" && input.recipe) saved.push(input.recipe);
        },
      },
      step: async () => undefined,
      taskRef: () => ({ taskId: "run-1", taskTitle: "Задача" }),
    } as unknown as WorkGuideHost;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await ensureWorkGuides(host, { id: "run-1" } as Run);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]?.watchesTasks).toBe(false);
    expect(saved[0]?.notes).toContain("не сервис для задач");
    expect(saved[0]?.notes).not.toMatch(/Смотри страницу/);
  });

  it("оставляет сервис для задач в обходе, даже если разбор не увидел задач", async () => {
    const snap: ServicesSnapshot = {
      generatedAt: "t",
      recipes: [recipe({ slug: "notion", name: "Notion", kind: "browser", domains: ["notion.so"], watchesTasks: true, notes: "Вход по паролю." })],
      credentials: [{ slug: "notion", kind: "browser", password: "pw" }],
    };
    const saved: ServiceRecipe[] = [];
    const chat = vi.fn(async () => ({
      text: JSON.stringify({ watchesTasks: false, objects: "", myWork: "", actions: "", avoid: "" }),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: [{ url: "https://notion.so/help/getting-started", title: "Start", content: "страницы и базы" }],
    }));
    const fetchImpl = vi.fn(async () => {
      return new Response("<html><title>Start</title><body><p>Notion хранит страницы и базы. Назначенных задач на странице справки не показано, список может быть пуст.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const host = {
      model: "m",
      openRouter: { chat } as unknown as OpenRouterClient,
      store: { readServices: async () => snap, addUsage: vi.fn() },
      services: {
        applyReport: async (input: { type: string; recipe?: ServiceRecipe }) => {
          if (input.type === "recipe" && input.recipe) saved.push(input.recipe);
        },
      },
      step: async () => undefined,
      taskRef: () => ({ taskId: "run-1", taskTitle: "Задача" }),
    } as unknown as WorkGuideHost;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await ensureWorkGuides(host, { id: "run-1" } as Run);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]?.watchesTasks).toBe(true);
    expect(saved[0]?.notes).toContain("Смотри страницу сервиса");
    expect(saved[0]?.notes).not.toContain("не сервис для задач");
  });

  it("заново смотрит сервис, который сняли с обхода из-за пустого списка", async () => {
    const snap: ServicesSnapshot = {
      generatedAt: "t",
      recipes: [
        recipe({
          slug: "jira",
          name: "Jira",
          kind: "api",
          domains: ["atlassian.net"],
          watchesTasks: false,
          notes: "Как работать: назначенных задач нет. По расписанию сюда не заходить.",
        }),
      ],
      credentials: [{ slug: "jira", kind: "api", token: "tok" }],
    };
    const saved: ServiceRecipe[] = [];
    const chat = vi.fn(async (_m: unknown, opts: { webSearch?: unknown }) => ({
      text: opts.webSearch ? "справка" : guideJson,
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: opts.webSearch ? [{ url: "https://support.atlassian.com/jira-software/getting-started", title: "Start", content: "задачи и доски" }] : [],
    }));
    const fetchImpl = vi.fn(async () => {
      return new Response("<html><title>Start</title><body><p>Jira — это задачи и доски. Назначенные вам карточки лежат в меню слева, их можно открыть и перенести.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const host = {
      model: "m",
      openRouter: { chat } as unknown as OpenRouterClient,
      store: { readServices: async () => snap, addUsage: vi.fn() },
      services: {
        applyReport: async (input: { type: string; recipe?: ServiceRecipe }) => {
          if (input.type === "recipe" && input.recipe) saved.push(input.recipe);
        },
      },
      step: async () => undefined,
      taskRef: () => ({ taskId: "run-1", taskTitle: "Задача" }),
    } as unknown as WorkGuideHost;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await ensureWorkGuides(host, { id: "run-1" } as Run);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]?.watchesTasks).toBe(true);
    expect(saved[0]?.notes).not.toContain("назначенных задач нет");
    expect(saved[0]?.notes).toContain("Мои карточки");
  });
});
