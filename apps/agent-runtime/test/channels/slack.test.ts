import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Run, ServiceRecipe } from "@swarm/contracts";
import { decodeSlackChoice } from "@swarm/contracts";
import { hearSlack, slackConversations, slackPlainText, slackReadFiles, slackThreadLine } from "../../src/channels/slack";
import { acceptSlackEvent, deliverChannelReply, listenMessengers } from "../../src/channels/listen";
import { Store } from "../../src/store";
import { readJson, writeJson } from "../../src/store/files";
import type { AgentRuntime } from "../../src/runtime";

describe("hearSlack", () => {
  it("берёт личные сообщения человека и пропускает свои", () => {
    const heard = hearSlack({
      teamId: "T1",
      selfId: "UBOT",
      channelId: "D1",
      im: true,
      messages: [
        { type: "message", user: "UALICE", text: "привет", ts: "100.000001" },
        { type: "message", user: "UBOT", text: "я сам", ts: "100.000002" },
        { type: "message", subtype: "channel_join", user: "UALICE", text: "joined", ts: "100.000003" },
      ],
    });
    expect(heard.map((item) => item.text)).toEqual(["привет"]);
    expect(heard[0]?.threadKey).toBe("slack:T1:D1");
    expect(heard[0]?.threadTs).toBeUndefined();
    expect(heard[0]?.replyTs).toBe("100.000001");
  });

  it("в канале оставляет только упоминание и отвечает в тред", () => {
    const heard = hearSlack({
      teamId: "T1",
      selfId: "UBOT",
      channelId: "C1",
      im: false,
      messages: [
        { type: "message", user: "UALICE", text: "просто болтовня", ts: "100.000001" },
        { type: "message", user: "UALICE", text: "посмотри <@UBOT> отчёт", ts: "100.000002", thread_ts: "100.000002" },
      ],
    });
    expect(heard).toHaveLength(1);
    expect(heard[0]?.text).toBe("посмотри отчёт");
    expect(heard[0]?.threadTs).toBe("100.000002");
    expect(heard[0]?.replyTs).toBe("100.000002");
    expect(heard[0]?.threadKey).toBe("slack:T1:C1:100.000002");
  });

  it("в уже открытом треде берёт реплику без нового упоминания", () => {
    const heard = hearSlack({
      teamId: "T1",
      selfId: "UBOT",
      channelId: "C1",
      im: false,
      followedThreads: new Set(["100.000002"]),
      messages: [
        { type: "message", user: "UALICE", text: "просто в канале", ts: "100.000003" },
        { type: "message", user: "UBOB", text: "а срок какой?", ts: "100.000004", thread_ts: "100.000002" },
        { type: "message", user: "UBOB", text: "другой тред", ts: "100.000005", thread_ts: "9.1" },
      ],
    });
    expect(heard.map((item) => item.text)).toEqual(["а срок какой?"]);
    expect(heard[0]?.replyTs).toBe("100.000002");
    expect(heard[0]?.threadKey).toBe("slack:T1:C1:100.000002");
  });

  it("слышит упоминание бота и app_mention, даже если id не совпал с user token", () => {
    const heard = hearSlack({
      teamId: "T1",
      selfId: "UUSER",
      botUserIds: ["UBOT"],
      channelId: "C1",
      im: false,
      messages: [
        { type: "message", user: "UALICE", text: "<@UBOT> сделай отчёт", ts: "100.000001" },
        { type: "app_mention", user: "UALICE", text: "и это тоже", ts: "100.000002" },
        { type: "message", user: "UALICE", text: "просто болтовня", ts: "100.000003" },
      ],
    });
    expect(heard.map((item) => item.text)).toEqual(["сделай отчёт", "и это тоже"]);
  });

  it("в личке берёт файл без текста и в канале ждёт упоминание", () => {
    const file = {
      id: "F1",
      name: "data.csv",
      mimetype: "text/csv",
      size: 4,
      preview: "а,1",
    };
    const dm = hearSlack({
      teamId: "T1",
      selfId: "UBOT",
      channelId: "D1",
      im: true,
      messages: [{ type: "message", subtype: "file_share", user: "UALICE", text: "", ts: "100.000010", files: [file] }],
    });
    expect(dm).toHaveLength(1);
    expect(dm[0]?.text).toBe("");
    expect(dm[0]?.replyTs).toBe("100.000010");
    expect(dm[0]?.files).toEqual([file]);

    const channel = hearSlack({
      teamId: "T1",
      selfId: "UBOT",
      channelId: "C1",
      im: false,
      messages: [
        { type: "message", subtype: "file_share", user: "UALICE", ts: "100.000011", files: [file] },
        { type: "message", subtype: "file_share", user: "UALICE", text: "<@UBOT> таблица", ts: "100.000012", files: [file] },
      ],
    });
    expect(channel.map((item) => item.text)).toEqual(["таблица"]);
    expect(channel[0]?.files[0]?.name).toBe("data.csv");
  });
});

describe("slackConversations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("просит личные диалоги формой: в JSON Slack отбрасывает types", async () => {
    let contentType = "";
    let body = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      contentType = String((init?.headers as Record<string, string>)["Content-Type"] ?? "");
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true, channels: [{ id: "D1", is_im: true }] }));
    });
    const found = await slackConversations("xoxb-test", globalThis.fetch);
    expect(contentType).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(body).get("types")).toContain("im");
    expect(found).toEqual([{ id: "D1", im: true }]);
  });
});

describe("slackReadFiles", () => {
  it("вкладывает текст и не ходит на чужой адрес", async () => {
    const hosts: string[] = [];
    const fetchImpl = async (url: string) => {
      hosts.push(new URL(String(url)).host);
      return new Response(
        JSON.stringify({
          ok: true,
          file: {
            id: "F1",
            name: "data.csv",
            mimetype: "text/csv",
            size: 4,
            url_private_download: "https://evil.example/data.csv",
          },
        }),
      );
    };
    const text = await slackReadFiles("xoxp-test", "разбери", [{ id: "F1", name: "data.csv", mimetype: "text/csv", size: 4 }], null, fetchImpl as typeof fetch);
    expect(text).toContain("разбери");
    expect(text).toContain("содержимое не прочитано");
    expect(hosts).toEqual(["slack.com"]);
  });

  it("скачивает текст после редиректа без токена на втором хосте", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const href = String(url);
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      calls.push({ url: href, auth });
      if (href.endsWith("files.info")) {
        return new Response(
          JSON.stringify({
            ok: true,
            file: {
              id: "F1",
              name: "data.csv",
              mimetype: "text/csv",
              size: 4,
              url_private_download: "https://files.slack.com/files-pri/T/F1/download/data.csv",
            },
          }),
        );
      }
      if (href.startsWith("https://files.slack.com/")) {
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: "https://cdn.example/data.csv" } });
      }
      return new Response("а,1\n", { headers: { "content-type": "text/csv" } });
    };
    const text = await slackReadFiles(
      "xoxp-test",
      "",
      [{ id: "F1", name: "data.csv", mimetype: "text/csv", size: 4, preview: "черновик" }],
      null,
      fetchImpl as typeof fetch,
    );
    expect(text).toContain("data.csv");
    expect(text).toContain("а,1");
    expect(text).not.toContain("черновик");
    expect(calls.find((call) => call.url.includes("cdn.example"))?.auth).toBe("");
    expect(calls.find((call) => call.url.startsWith("https://files.slack.com/"))?.auth).toContain("xoxp-test");
  });

  it("кладёт картинку на диск и говорит её открыть", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "swarm-slack-file-"));
    try {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const fetchImpl = async (url: string) => {
        if (String(url).endsWith("files.info")) {
          return new Response(
            JSON.stringify({
              ok: true,
              file: {
                id: "F9",
                name: "photo.png",
                mimetype: "image/png",
                size: png.byteLength,
                url_private_download: "https://files.slack.com/files-pri/T/F9/download/photo.png",
              },
            }),
          );
        }
        return new Response(png, { headers: { "content-type": "image/png" } });
      };
      const text = await slackReadFiles(
        "xoxp-test",
        "посмотри",
        [{ id: "F9", name: "photo.png", mimetype: "image/png", size: png.byteLength }],
        dir,
        fetchImpl as typeof fetch,
      );
      expect(text).toContain("посмотри");
      expect(text).toContain("открой и посмотри");
      const saved = path.join(dir, "F9-photo.png");
      expect(text).toContain(saved);
      expect(await readFile(saved)).toEqual(Buffer.from(png));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("без права files:read оставляет имя и превью", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: "missing_scope" }));
    const text = await slackReadFiles(
      "xoxp-test",
      "",
      [{ id: "F1", name: "data.csv", mimetype: "text/csv", size: 4, preview: "а,1" }],
      null,
      fetchImpl as typeof fetch,
    );
    expect(text).toContain("нет права files:read");
    expect(text).toContain("а,1");
  });
});

describe("slackThreadLine", () => {
  it("показывает файл в треде и пропускает служебное сообщение", () => {
    expect(
      slackThreadLine({
        type: "message",
        subtype: "file_share",
        text: "таблица",
        files: [{ id: "F1", name: "data.csv", mimetype: "text/csv", size: 4, preview: "а,1" }],
      }),
    ).toContain("data.csv");
    expect(slackThreadLine({ type: "message", subtype: "channel_join", text: "joined" })).toBe("");
  });
});

describe("slackPlainText", () => {
  it("убирает упоминание и раскрывает ссылку", () => {
    expect(slackPlainText("см <@UBOT> <https://example.com|сайт>")).toBe("см сайт");
  });
});

describe("listenMessengers", () => {
  let root = "";

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("открывает один чат на личку и второй раз то же сообщение не берёт", async () => {
    root = await mkdtemp(path.join(tmpdir(), "swarm-slack-"));
    const store = new Store(root);
    await store.init();
    await store.writeServices({
      generatedAt: "t",
      recipes: [
        {
          slug: "slack",
          name: "Slack",
          kind: "api",
          domains: ["slack.com"],
          notes: "Как работать: смотри упоминания.",
          discoveredBy: null,
          watchesTasks: true,
        },
      ],
      credentials: [{ slug: "slack", kind: "api", token: "xoxb-test" }],
    });

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").pop();
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) as { channel?: string; ts?: string };
      calls.push(method ?? "");
      const payload =
        method === "auth.test"
          ? { ok: true, user_id: "UBOT", team_id: "T1" }
          : method === "conversations.list"
            ? { ok: true, channels: [{ id: "D1", is_im: true }] }
            : method === "conversations.history"
              ? {
                  ok: true,
                  messages: body.channel
                    ? [{ type: "message", user: "UALICE", text: "сделай отчёт", ts: "200.000100" }]
                    : [],
                }
              : method === "users.info"
                ? { ok: true, user: { real_name: "Алиса", profile: { display_name: "Алиса" } } }
                : method === "conversations.replies"
                  ? body.ts === "200.000100"
                    ? { ok: true, messages: [{ type: "message", user: "UALICE", text: "сделай отчёт", ts: "200.000100" }] }
                    : {
                        ok: true,
                        messages: [
                          { type: "message", user: "UALICE", text: "посмотри <@UBOT> отчёт", ts: "400.000100" },
                          { type: "message", user: "UBOB", text: "а срок?", ts: "400.000200", thread_ts: "400.000100" },
                        ],
                      }
                  : { ok: false, error: method };
      return new Response(JSON.stringify(payload));
    });

    const runs: Run[] = [];
    const rt = {
      store,
      services: {
        knownRecipe: async () => null,
        applyReport: async (input: { type: string; recipe?: ServiceRecipe }) => {
          if (input.type !== "recipe" || !input.recipe) return;
          const snap = await store.readServices();
          if (!snap) return;
          snap.recipes = snap.recipes.map((recipe) => (recipe.slug === input.recipe?.slug ? input.recipe : recipe));
          await store.writeServices(snap);
        },
      },
      isCanceled: async () => false,
      openRouter: {
        chat: async () => ({
          text: JSON.stringify({ kind: "task", service: null, serviceDomain: null }),
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          model: "m",
          citations: [],
        }),
      },
      createRun: async (trigger: Run["trigger"], title: string, threadId: string | null) => {
        const run = {
          id: `run_${runs.length + 1}`,
          title,
          threadId,
          status: "running",
          trigger,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
          summary: "",
        } as Run;
        runs.push(run);
        await store.saveRun(run);
        return run;
      },
      addChat: async (msg: { chatId?: string; text: string; role: "user" | "agent"; runId: string | null; author?: string }) => {
        const chatId = msg.chatId ?? "";
        await store.chats.addMessage(chatId, {
          at: new Date().toISOString(),
          role: msg.role,
          text: msg.text,
          runId: msg.runId,
          chatId,
          ...(msg.author ? { author: msg.author } : {}),
        });
      },
      step: async () => undefined,
      finishRun: async (run: Run, status: Run["status"], summary: string) => {
        run.status = status;
        run.summary = summary;
        await store.saveRun(run);
      },
      think: async () => ({ text: "задач нет", usedFallback: false, startedAt: "2026-01-01T00:00:00.000Z" }),
    } as unknown as AgentRuntime;

    expect(await listenMessengers(rt)).toBe(1);
    await vi.waitFor(() => expect(runs[0]?.status).toBe("done"));
    const chats = await store.chats.list();
    expect(chats.map((chat) => chat.title)).toEqual(["Slack · Алиса"]);
    expect(chats[0]?.kind).toBe("channel");
    const messages = await store.chats.listMessages(chats[0]!.id);
    expect(messages[0]).toMatchObject({ role: "user", text: "сделай отчёт", author: "Алиса" });
    expect(runs[0]?.threadId).toBe(chats[0]?.id);
    const inbox = await readJson<{ replyTo?: Record<string, string>; threads?: Record<string, string[]> }>(
      store.dir("channel-inbox.json"),
      {},
    );
    expect(inbox.replyTo?.run_1).toBe("200.000100");
    expect(inbox.threads?.["slack:D1"]).toContain("200.000100");

    const before = calls.length;
    expect(await listenMessengers(rt)).toBe(0);
    expect(calls.length).toBeGreaterThan(before);
    expect(runs).toHaveLength(1);

    const saved = await store.readServices();
    expect(saved?.recipes[0]?.channel).toBe("messenger");
    expect(saved?.recipes[0]?.watchesTasks).toBe(false);
    expect(saved?.recipes[0]?.notes).toContain("Канал связи:");

    expect(
      await acceptSlackEvent(rt, {
        eventId: "Ev-dm",
        teamId: "T1",
        event: { type: "message", channel: "D1", channelType: "im", user: "UALICE", text: "из события", ts: "300.000100" },
      }),
    ).toBe("accepted");
    expect(
      await acceptSlackEvent(rt, {
        eventId: "Ev-again",
        teamId: "T1",
        event: { type: "message", channel: "D1", channelType: "im", user: "UALICE", text: "из события", ts: "300.000100" },
      }),
    ).toBe("duplicate");
    expect(
      await acceptSlackEvent(rt, {
        eventId: "Ev-bot",
        teamId: "T1",
        event: { type: "message", channel: "D1", channelType: "im", user: "UBOT", botId: "B1", text: "я сам", ts: "300.000200" },
      }),
    ).toBe("ignored");
    expect(
      await acceptSlackEvent(rt, {
        eventId: "Ev-mention",
        teamId: "T1",
        event: { type: "app_mention", channel: "C1", user: "UALICE", text: "посмотри <@UBOT> отчёт", ts: "400.000100" },
      }),
    ).toBe("accepted");
    await vi.waitFor(() => expect(runs.filter((run) => run.status === "done")).toHaveLength(3));
    const titles = (await store.chats.list()).map((chat) => chat.title);
    expect(titles).toContain("Slack · Алиса");
    expect(runs).toHaveLength(3);

    const prompts: string[] = [];
    rt.think = async (_run: unknown, prompt: string) => {
      prompts.push(prompt);
      return { text: "до пятницы", usedFallback: false, startedAt: "2026-01-01T00:00:00.000Z" };
    };
    expect(
      await acceptSlackEvent(rt, {
        eventId: "Ev-reply",
        teamId: "T1",
        event: {
          type: "message",
          channel: "C1",
          channelType: "channel",
          user: "UBOB",
          text: "а срок?",
          ts: "400.000200",
          threadTs: "400.000100",
        },
      }),
    ).toBe("accepted");
    await vi.waitFor(() => expect(prompts.some((prompt) => prompt.includes("а срок?") && prompt.includes("посмотри"))).toBe(true));
    expect(runs).toHaveLength(4);
    expect(runs[3]?.threadId).toBe(runs[2]?.threadId);
    await vi.waitFor(async () => {
      const messages = await store.chats.listMessages(runs[3]!.threadId!);
      expect(messages.some((message) => message.role === "agent" && message.text.includes("до пятницы"))).toBe(true);
    });
  });

  it("принимает упоминание бота, когда auth.test вернул id пользователя", async () => {
    root = await mkdtemp(path.join(tmpdir(), "swarm-slack-bot-"));
    const store = new Store(root);
    await store.init();
    await store.writeServices({
      generatedAt: "t",
      recipes: [
        {
          slug: "slack",
          name: "Slack",
          kind: "api",
          domains: ["slack.com"],
          notes: "",
          discoveredBy: null,
          channel: "messenger",
        },
      ],
      credentials: [
        {
          slug: "slack",
          kind: "api",
          token: "xoxp-user",
          oauth: { accessToken: "xoxp-user", botUserId: "UBOT" },
        },
      ],
    });
    vi.stubGlobal("fetch", async (url: string) => {
      const method = String(url).split("/").pop();
      const payload =
        method === "auth.test"
          ? { ok: true, user_id: "UUSER", team_id: "T1" }
          : method === "users.info"
            ? { ok: true, user: { real_name: "Алиса" } }
            : method === "conversations.replies"
              ? { ok: true, messages: [] }
              : { ok: false, error: method };
      return new Response(JSON.stringify(payload));
    });
    const rt = {
      cfg: { agentId: "agt_1" },
      store,
      services: { applyReport: async () => undefined, knownRecipe: async () => null },
      openRouter: {
        chat: async () => ({
          text: JSON.stringify({ kind: "task", service: null, serviceDomain: null }),
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          model: "m",
          citations: [],
        }),
      },
      isCanceled: async () => false,
      createRun: async () => {
        const run = {
          id: "run_bot",
          title: "slack",
          threadId: null,
          status: "running",
          trigger: "chat",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
          summary: "",
        } as Run;
        await store.saveRun(run);
        return run;
      },
      addChat: async (msg: { chatId?: string; text: string; role: "user" | "agent"; runId: string | null }) => {
        const chatId = msg.chatId ?? "";
        await store.chats.addMessage(chatId, {
          at: new Date().toISOString(),
          role: msg.role,
          text: msg.text,
          runId: msg.runId,
          chatId,
        });
      },
      step: async () => undefined,
      finishRun: async (run: Run, status: Run["status"], summary: string) => {
        run.status = status;
        run.summary = summary;
        await store.saveRun(run);
      },
      think: async () => ({ text: "пусто", usedFallback: false, startedAt: "2026-01-01T00:00:00.000Z" }),
    } as unknown as AgentRuntime;

    expect(
      await acceptSlackEvent(rt, {
        eventId: "Ev-bot-mention",
        teamId: "T1",
        event: { type: "app_mention", channel: "C1", user: "UALICE", text: "<@UBOT> отчёт", ts: "500.000100" },
      }),
    ).toBe("accepted");
    await vi.waitFor(async () => {
      const run = await store.getRun("run_bot");
      expect(run?.status).toBe("done");
    });
  });

  it("кладёт содержимое файла из лички в задачу", async () => {
    root = await mkdtemp(path.join(tmpdir(), "swarm-slack-file-msg-"));
    const store = new Store(root);
    await store.init();
    await store.writeServices({
      generatedAt: "t",
      recipes: [
        {
          slug: "slack",
          name: "Slack",
          kind: "api",
          domains: ["slack.com"],
          notes: "",
          discoveredBy: null,
          channel: "messenger",
        },
      ],
      credentials: [{ slug: "slack", kind: "api", token: "xoxp-user" }],
    });
    vi.stubGlobal("fetch", async (url: string) => {
      const href = String(url);
      if (href.startsWith("https://files.slack.com/")) return new Response("а,1\n", { headers: { "content-type": "text/csv" } });
      const method = href.split("/").pop();
      const payload =
        method === "auth.test"
          ? { ok: true, user_id: "UBOT", team_id: "T1" }
          : method === "users.info"
            ? { ok: true, user: { real_name: "Алиса" } }
            : method === "files.info"
              ? {
                  ok: true,
                  file: {
                    id: "F1",
                    name: "data.csv",
                    mimetype: "text/csv",
                    size: 4,
                    url_private_download: "https://files.slack.com/files-pri/T/F1/download/data.csv",
                  },
                }
              : { ok: false, error: method };
      return new Response(JSON.stringify(payload));
    });
    const rt = {
      cfg: { agentId: "agt_1" },
      store,
      services: { applyReport: async () => undefined, knownRecipe: async () => null },
      openRouter: {
        chat: async () => ({
          text: JSON.stringify({ kind: "task", service: null, serviceDomain: null }),
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          model: "m",
          citations: [],
        }),
      },
      isCanceled: async () => false,
      createRun: async () => {
        const run = {
          id: "run_file",
          title: "slack",
          threadId: null,
          status: "running",
          trigger: "chat",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
          summary: "",
        } as Run;
        await store.saveRun(run);
        return run;
      },
      addChat: async (msg: { chatId?: string; text: string; role: "user" | "agent"; runId: string | null; author?: string }) => {
        const chatId = msg.chatId ?? "";
        await store.chats.addMessage(chatId, {
          at: new Date().toISOString(),
          role: msg.role,
          text: msg.text,
          runId: msg.runId,
          chatId,
          ...(msg.author ? { author: msg.author } : {}),
        });
      },
      step: async () => undefined,
      finishRun: async (run: Run, status: Run["status"], summary: string) => {
        run.status = status;
        run.summary = summary;
        await store.saveRun(run);
      },
      think: async () => ({ text: "пусто", usedFallback: false, startedAt: "2026-01-01T00:00:00.000Z" }),
    } as unknown as AgentRuntime;

    expect(
      await acceptSlackEvent(rt, {
        eventId: "Ev-file",
        teamId: "T1",
        event: {
          type: "message",
          subtype: "file_share",
          channel: "D1",
          channelType: "im",
          user: "UALICE",
          text: "разбери",
          ts: "600.000100",
          files: [{ id: "F1", name: "data.csv", mimetype: "text/csv", size: 4 }],
        },
      }),
    ).toBe("accepted");
    await vi.waitFor(async () => {
      const run = await store.getRun("run_file");
      expect(run?.status).toBe("done");
      const chats = await store.chats.list();
      const messages = await store.chats.listMessages(chats[0]!.id);
      expect(messages.some((message) => message.role === "user" && message.text.includes("разбери") && message.text.includes("а,1"))).toBe(true);
    });
  });
});

describe("deliverChannelReply", () => {
  let root = "";

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const question: ChatMessage = {
    at: "t",
    role: "agent",
    kind: "approval",
    approvalId: "qst_1",
    text: "Какой срок?",
    options: ["Завтра", "На неделе"],
    runId: "run_1",
    chatId: "chat_1",
  };

  async function runtime(botToken?: string) {
    root = await mkdtemp(path.join(tmpdir(), "swarm-slack-reply-"));
    const store = new Store(root);
    await store.init();
    await store.writeServices({
      generatedAt: "t",
      recipes: [],
      credentials: [
        {
          slug: "slack",
          kind: "api",
          token: "xoxp-user",
          ...(botToken ? { oauth: { accessToken: "xoxp-user", botToken } } : {}),
        },
      ],
    });
    return {
      cfg: { agentId: "agt_1" },
      store,
      step: async () => undefined,
    } as unknown as AgentRuntime;
  }

  function capture(botOk = true) {
    const posts: Array<{ token: string; body: URLSearchParams }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const token = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", "");
      const body = new URLSearchParams(String(init?.body ?? ""));
      posts.push({ token, body });
      if (token === "xoxb-bot" && !botOk) return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }));
      return new Response(JSON.stringify({ ok: true, ts: token === "xoxb-bot" ? "9.1" : "9.2" }));
    });
    return posts;
  }

  it("в канале пишет кнопки токеном бота", async () => {
    const rt = await runtime("xoxb-bot");
    const posts = capture();
    await deliverChannelReply(
      rt,
      { adapter: "slack", slug: "slack", threadKey: "slack:T1:C1:1.0", channel: "C1", threadTs: "1.0" },
      question,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.token).toBe("xoxb-bot");
    const blocks = JSON.parse(posts[0]?.body.get("blocks") ?? "[]") as Array<{ type: string; elements?: Array<{ value: string; text: { text: string } }> }>;
    const buttons = blocks.find((block) => block.type === "actions")?.elements ?? [];
    expect(buttons.map((button) => button.text.text)).toEqual(["Завтра", "На неделе"]);
    expect(decodeSlackChoice(buttons[1]?.value ?? "")).toEqual({ agentId: "agt_1", approvalId: "qst_1", index: 1 });
    expect(posts[0]?.body.get("thread_ts")).toBe("1.0");
  });

  it("в личке отвечает тредом на сообщение задачи", async () => {
    const rt = await runtime();
    const posts = capture();
    await writeJson(rt.store.dir("channel-inbox.json"), {
      seen: [],
      cursors: {},
      names: {},
      identities: {},
      replyTo: { run_1: "5.5" },
      threads: { "slack:D1": ["5.5"] },
    });
    await deliverChannelReply(
      rt,
      { adapter: "slack", slug: "slack", threadKey: "slack:T1:D1", channel: "D1" },
      { at: "t", role: "agent", kind: "text", text: "готово", runId: "run_1", chatId: "chat_1" },
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.token).toBe("xoxp-user");
    expect(posts[0]?.body.get("thread_ts")).toBe("5.5");
    expect(posts[0]?.body.get("text")).toBe("готово");
  });

  it("в личке оставляет нумерованный текст от пользователя", async () => {
    const rt = await runtime("xoxb-bot");
    const posts = capture();
    await deliverChannelReply(
      rt,
      { adapter: "slack", slug: "slack", threadKey: "slack:T1:D1", channel: "D1" },
      question,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.token).toBe("xoxp-user");
    expect(posts[0]?.body.get("blocks")).toBeNull();
    expect(posts[0]?.body.get("text")).toContain("1. Завтра");
    expect(posts[0]?.body.get("text")).toContain("2. На неделе");
  });

  it("если бот не в канале, отвечает текстом", async () => {
    const rt = await runtime("xoxb-bot");
    const posts = capture(false);
    await deliverChannelReply(
      rt,
      { adapter: "slack", slug: "slack", threadKey: "slack:T1:C1:1.0", channel: "C1", threadTs: "1.0" },
      question,
    );
    expect(posts.map((post) => post.token)).toEqual(["xoxb-bot", "xoxp-user"]);
    expect(posts[1]?.body.get("blocks")).toBeNull();
    expect(posts[1]?.body.get("text")).toContain("1. Завтра");
  });
});
