import { describe, expect, it } from "vitest";
import { escalationNote, humanPage, onboardingPrompt, serviceWorkPrompt, systemPrompt, taskServices, tickPrompt } from "../../src/llm/prompts";
import { isMachineSender } from "../../src/tasks/inbox";

describe("escalationNote", () => {
  it("points a person at the service page and keeps the Skyvern screen separate", () => {
    expect(humanPage("https://gensite.ru/login")).toBe("https://gensite.ru/login");
    expect(humanPage("https://app.skyvern.com/sessions/1")).toBeNull();
    expect(escalationNote("капча", "https://gensite.ru/login")).toMatch(/gensite\.ru\/login/);
    expect(escalationNote("капча", "https://app.skyvern.com/sessions/1")).toMatch(/взять управление/);
    expect(escalationNote("капча", null)).toMatch(/взять управление некуда/);
  });
});

describe("onboardingPrompt cookies", () => {
  it("treats Skyvern cookies transferred into the local profile as saved", () => {
    const text = onboardingPrompt({
      recipe: null,
      discovery: null,
      inviteUrl: "https://app.acme.io/invite/1",
      invite: {
        status: "accepted",
        accountEmail: "bot@agents.test",
        password: "pw",
        steps: 3,
        finalUrl: "https://app.acme.io/",
        notes: "",
        provider: "skyvern",
        cookiesInProfile: true,
      },
      inviteSkipped: null,
      browserAvailable: true,
      slug: "acme",
      engine: { status: "ready", mode: "browser", reason: "ok", liveUrl: null, handoffId: null },
    });
    expect(text).toMatch(/Cookies сохранены/);
    expect(text).toMatch(/serviceSlug "acme"/);
  });
});

describe("service work from a notification", () => {
  it("sends the agent into the service and does not answer a mailbox", () => {
    const prompt = serviceWorkPrompt("notification");
    expect(prompt).toMatch(/в самом сервисе/);
    expect(prompt).toMatch(/Отправителю этого письма не отвечай/);
    expect(isMachineSender("Pneumatic <no-reply@pneumatic.app>")).toBe(true);
    expect(isMachineSender("Владелец <owner@cedricillya.online>")).toBe(false);
  });
});

describe("systemPrompt recipe details", () => {
  it("shows API baseUrl, docs and journal rule", () => {
    const text = systemPrompt({
      agentName: "Бот",
      email: "bot@example.com",
      ownerEmail: null,
      autonomous: false,
      runtimePort: 8787,
      services: {
        generatedAt: "t",
        recipes: [
          {
            slug: "pneumatic",
            name: "Pneumatic",
            kind: "api",
            domains: ["pneumatic.app"],
            api: {
              baseUrl: "https://api.pneumatic.app",
              docsUrl: "https://api-docs.pneumatic.app/",
              auth: "bearer",
              authHeader: "Authorization",
            },
            notes: "Ключ: Integrations",
            discoveredBy: null,
          },
        ],
        credentials: [{ slug: "pneumatic", kind: "api", token: "x", accountEmail: "bot@example.com" }],
      },
    });
    expect(text).toContain("https://api.pneumatic.app");
    expect(text).toContain("Как работать");
    expect(text).toContain("https://api-docs.pneumatic.app/");
    expect(text).toContain("Ключ: Integrations");
    expect(text).toMatch(/kind mcp\|api\|browser/);
  });

  it("OAuth-MCP без токена: способ — как у доступа, инструментов не обещает", () => {
    const text = systemPrompt({
      agentName: "Бот",
      email: "bot@example.com",
      ownerEmail: null,
      autonomous: false,
      runtimePort: 8787,
      services: {
        generatedAt: "t",
        recipes: [
          {
            slug: "trello",
            name: "Trello",
            kind: "mcp",
            domains: ["trello.com"],
            mcp: { url: "https://mcp.trello.com/v1", transport: "streamable_http", auth: "oauth", includeTools: [] },
            notes: "",
            discoveredBy: null,
          },
        ],
        credentials: [{ slug: "trello", kind: "browser", password: "pw", accountEmail: "bot@example.com" }],
      },
    });
    expect(text).toContain("Trello (trello): способ browser");
    expect(text).toMatch(/только OAuth/);
    expect(text).not.toMatch(/Инструменты: mcp_trello_\*/);
  });

  it("записанный до проверки токен API не обещает инструменты MCP", () => {
    const text = systemPrompt({
      agentName: "Бот",
      email: "bot@example.com",
      ownerEmail: null,
      autonomous: false,
      runtimePort: 8787,
      services: {
        generatedAt: "t",
        recipes: [
          {
            slug: "trello",
            name: "Trello",
            kind: "mcp",
            domains: ["trello.com"],
            mcp: { url: "https://mcp.trello.com/v1", transport: "streamable_http", auth: "oauth", includeTools: [] },
            notes: "",
            discoveredBy: null,
          },
        ],
        credentials: [{ slug: "trello", kind: "browser", token: "trello-api-token-value", password: "pw" }],
      },
    });
    expect(text).toMatch(/Токен API уже записан/);
    expect(text).not.toMatch(/Инструменты: mcp_trello_\*/);
  });
});

describe("tick only opens services that have assigned work", () => {
  const services = {
    generatedAt: "t",
    recipes: [
      {
        slug: "linear",
        name: "Linear",
        kind: "mcp" as const,
        domains: ["linear.app"],
        notes: "",
        discoveredBy: null,
        watchesTasks: true,
      },
      {
        slug: "stripe",
        name: "Stripe",
        kind: "api" as const,
        domains: ["stripe.com"],
        notes: "",
        discoveredBy: null,
        watchesTasks: false,
      },
    ],
    credentials: [
      { slug: "linear", kind: "mcp" as const, token: "lin" },
      { slug: "stripe", kind: "api" as const, token: "sk" },
    ],
  };

  it("lists Linear and tells the agent to leave Stripe alone", () => {
    expect(taskServices(services).map((r) => r.slug)).toEqual(["linear"]);
    const text = tickPrompt(services);
    expect(text).toContain("Linear");
    expect(text).not.toContain("Stripe");
    expect(text).toMatch(/не открывай/);
    expect(text).toMatch(/Не выполняй/);
    expect(text).toContain("/tasks/found");
    expect(text).not.toMatch(/Выполни найденное/);
    const shown = systemPrompt({
      agentName: "Бот",
      email: "bot@example.com",
      ownerEmail: null,
      autonomous: true,
      runtimePort: 8787,
      services,
    });
    expect(shown).toContain("Задачи: смотреть назначенную работу.");
    expect(shown).toContain("Задачи: не смотреть.");
  });

  it("не ищет задачи в мессенджере и называет его каналом связи", () => {
    const withSlack = {
      ...services,
      recipes: [
        ...services.recipes,
        {
          slug: "slack",
          name: "Slack",
          kind: "api" as const,
          domains: ["slack.com"],
          notes: "",
          discoveredBy: null,
          watchesTasks: true as const,
        },
      ],
      credentials: [...services.credentials, { slug: "slack", kind: "api" as const, token: "xoxb" }],
    };
    expect(taskServices(withSlack).map((recipe) => recipe.slug)).toEqual(["linear"]);
    const shown = systemPrompt({
      agentName: "Бот",
      email: "bot@example.com",
      ownerEmail: null,
      autonomous: true,
      runtimePort: 8787,
      services: withSlack,
    });
    expect(shown).toContain("Канал связи, как почта и чат.");
    expect(shown).not.toMatch(/Slack[\s\S]*Задачи: смотреть/);
  });
});
