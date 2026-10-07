import { describe, expect, it, vi } from "vitest";
import type { Run, ServiceCredential, ServicesSnapshot } from "@swarm/contracts";
import { toExtractSchema } from "../../src/browser/schema";
import {
  TASK_LIST_SCHEMA,
  canonicalTasksUrl,
  landedOnTasksPage,
  pageDigest,
  readTasksPage,
  rememberTasksPage,
  type PageProbe,
} from "../../src/tasks/watch-page";

const domains = ["trello.com"];
const cards = "https://trello.com/u/me/cards";

function probe(start: string, opts?: { redirectToLogin?: boolean; text?: string; tasks?: unknown }): PageProbe & { extract: ReturnType<typeof vi.fn>; act: ReturnType<typeof vi.fn> } {
  let url = start;
  let logged = !opts?.redirectToLogin;
  const extract = vi.fn(async () => opts?.tasks ?? { tasks: [{ title: "Карточка", detail: "сделать", key: "https://trello.com/c/abc" }] });
  const act = vi.fn(async () => {
    logged = true;
    return { success: true, message: "ok" };
  });
  return {
    extract,
    act,
    async goto(next: string) {
      url = opts?.redirectToLogin && !logged && next.includes("/u/me/cards") ? "https://trello.com/login" : next;
    },
    async currentUrl() {
      return url;
    },
    async read() {
      return { url, text: opts?.text ?? "мои карточки ".repeat(40) };
    },
  };
}

const run = { id: "run_1", title: "Плановая проверка сервисов", status: "running" } as Run;

function services(cred: ServiceCredential): ServicesSnapshot {
  return {
    generatedAt: "t",
    recipes: [
      {
        slug: "trello",
        name: "Trello",
        kind: "browser",
        domains,
        notes: "Как работать: карточки.",
        discoveredBy: null,
        watchesTasks: true,
        browser: { loginUrl: "https://trello.com/login", appUrl: "https://trello.com/" },
      },
    ],
    credentials: [cred],
  };
}

describe("canonicalTasksUrl", () => {
  it("builds a schema Stagehand can extract", () => {
    const schema = toExtractSchema(TASK_LIST_SCHEMA)!;
    expect(schema.parse({ tasks: [{ title: "A", detail: "", key: "" }] })).toEqual({
      tasks: [{ title: "A", detail: "", key: "" }],
    });
    expect(schema.safeParse({ tasks: "нет" }).success).toBe(false);
  });

  it("keeps the list path and drops tracking params", () => {
    expect(canonicalTasksUrl(`${cards}?assignee=me&utm_source=mail`, domains)).toBe(`${cards}?assignee=me`);
    expect(canonicalTasksUrl("https://trello.com/login", domains)).toBeNull();
    expect(canonicalTasksUrl("https://trello.com/", domains)).toBeNull();
    expect(canonicalTasksUrl("http://trello.com/u/me/cards", domains)).toBeNull();
    expect(canonicalTasksUrl("https://evil.example/u/me/cards", domains)).toBeNull();
  });

  it("treats a redirect with extra params as the same list", () => {
    expect(landedOnTasksPage(cards, `${cards}?tab=list`, domains)).toBe(true);
    expect(landedOnTasksPage(cards, "https://trello.com/settings", domains)).toBe(false);
    expect(landedOnTasksPage(cards, "https://trello.com/login", domains)).toBe(false);
  });
});

describe("readTasksPage", () => {
  it("extracts the list without a login step when the page is already open", async () => {
    const page = probe(cards);
    const read = await readTasksPage(page, { tasksUrl: cards, domains, service: "trello", loginUrl: "https://trello.com/login" });
    expect(read.ok).toBe(true);
    expect(read.tasks).toEqual([{ service: "trello", title: "Карточка", detail: "сделать", key: "https://trello.com/c/abc" }]);
    expect(page.act).not.toHaveBeenCalled();
    expect(page.extract).toHaveBeenCalledTimes(1);
  });

  it("logs in once and returns to the saved page", async () => {
    const page = probe(cards, { redirectToLogin: true });
    const read = await readTasksPage(page, {
      tasksUrl: cards,
      domains,
      service: "trello",
      loginUrl: "https://trello.com/login",
      variables: { email: "a@b.c", password: "pw" },
    });
    expect(read.ok).toBe(true);
    expect(page.act).toHaveBeenCalledTimes(1);
    expect(page.extract).toHaveBeenCalledTimes(1);
  });

  it("skips extract when the page text has not changed", async () => {
    const text = "Карточка Fix. обновлено 2 минуты назад";
    const page = probe(cards, { text });
    const read = await readTasksPage(page, {
      tasksUrl: cards,
      domains,
      service: "trello",
      previousDigest: pageDigest("Карточка Fix. обновлено 9 минут назад"),
    });
    expect(read.reason).toBe("same");
    expect(read.tasks).toEqual([]);
    expect(page.extract).not.toHaveBeenCalled();
  });

  it("does not extract or accept another section", async () => {
    const page = probe("https://trello.com/settings");
    page.goto = async (next: string) => {
      void next;
    };
    const read = await readTasksPage(page, { tasksUrl: cards, domains, service: "trello" });
    expect(read).toMatchObject({ ok: false, reason: "other", tasks: [] });
    expect(page.extract).not.toHaveBeenCalled();
  });

  it("does not treat a short missing page as an empty list", async () => {
    const page = probe(cards, { text: "404 страница не найдена" });
    const read = await readTasksPage(page, { tasksUrl: cards, domains, service: "trello" });
    expect(read).toMatchObject({ ok: false, reason: "other" });
    expect(page.extract).not.toHaveBeenCalled();
  });
});

describe("rememberTasksPage", () => {
  it("saves the open list once and returns its tasks", async () => {
    const cred: ServiceCredential = { slug: "trello", kind: "browser", accountEmail: "a@b.c", password: "pw" };
    const snap = services(cred);
    const page = probe(cards);
    const applyReport = vi.fn(async (input: { credential: ServiceCredential }) => {
      snap.credentials = [input.credential];
    });
    const rt = {
      browser: { sessions: new Map([["ses", { ...page, serviceSlug: "trello" }]]) },
      store: { readServices: async () => snap },
      services: { applyReport },
      step: vi.fn(async () => undefined),
    };
    const first = await rememberTasksPage(rt as never, run, "trello");
    expect(first).toMatchObject({ ok: true, saved: true, url: cards });
    if (first.ok) expect(first.tasks).toHaveLength(1);
    expect(applyReport).toHaveBeenCalledTimes(1);
    const again = await rememberTasksPage(rt as never, run, "trello");
    expect(again).toMatchObject({ ok: true, saved: false, url: cards, tasks: [] });
    expect(page.extract).toHaveBeenCalledTimes(1);
  });

  it("does not save a login page", async () => {
    const cred: ServiceCredential = { slug: "trello", kind: "browser" };
    const snap = services(cred);
    const page = probe("https://trello.com/login");
    const applyReport = vi.fn();
    const rt = {
      browser: { sessions: new Map([["ses", { ...page, serviceSlug: "trello" }]]) },
      store: { readServices: async () => snap },
      services: { applyReport },
      step: vi.fn(async () => undefined),
    };
    const result = await rememberTasksPage(rt as never, run, "trello");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(applyReport).not.toHaveBeenCalled();
  });
});
