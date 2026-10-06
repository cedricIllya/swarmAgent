import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run, ServiceRecipe } from "@swarm/contracts";
import { hearSlack, slackPlainText } from "../../src/channels/slack";
import { listenMessengers } from "../../src/channels/listen";
import { Store } from "../../src/store";
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
    expect(heard[0]?.threadKey).toBe("slack:T1:C1:100.000002");
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
      const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string };
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

    const before = calls.length;
    expect(await listenMessengers(rt)).toBe(0);
    expect(calls.length).toBeGreaterThan(before);
    expect(runs).toHaveLength(1);

    const saved = await store.readServices();
    expect(saved?.recipes[0]?.channel).toBe("messenger");
    expect(saved?.recipes[0]?.watchesTasks).toBe(false);
    expect(saved?.recipes[0]?.notes).toContain("Канал связи:");
  });
});
