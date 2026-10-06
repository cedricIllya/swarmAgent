import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/store";

async function tmpStore(): Promise<Store> {
  const dir = await mkdtemp(path.join(tmpdir(), "swarm-store-"));
  const store = new Store(dir);
  await store.init();
  return store;
}

describe("chats", () => {
  it("moves the legacy chat.jsonl into its own thread and keeps later chats apart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "swarm-store-"));
    await writeFile(
      path.join(dir, "chat.jsonl"),
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", role: "user", text: "привет", runId: null }) + "\n",
    );
    const store = new Store(dir);
    await store.init();

    const chats = await store.chats.list();
    const general = chats.find((c) => c.title === "Общий");
    expect(general).toBeTruthy();
    const migrated = await readFile(path.join(dir, "chat.jsonl.migrated"), "utf8");
    expect(migrated).toContain("привет");

    const messages = await store.chats.listMessages(general!.id);
    expect(messages.map((m) => m.text)).toEqual(["привет"]);
    expect(messages[0]?.chatId).toBe(general!.id);

    const other = await store.chats.create("Второй");
    await store.chats.addMessage(other.id, {
      at: "2026-01-02T00:00:00.000Z",
      role: "user",
      text: "другое",
      runId: null,
      chatId: other.id,
    });
    expect((await store.chats.listMessages(general!.id)).map((m) => m.text)).toEqual(["привет"]);
    expect((await store.chats.listMessages(other.id)).map((m) => m.text)).toEqual(["другое"]);
  });

  it("marks a chat busy only while its run is going", async () => {
    const store = await tmpStore();
    const chat = await store.chats.create("Задача");
    await store.saveRun({
      id: "run_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      status: "running",
      trigger: "chat",
      title: "Задача",
      summary: "",
      threadId: chat.id,
    });
    expect((await store.chats.list()).find((c) => c.id === chat.id)?.busy).toBe(true);
    await store.saveRun({
      id: "run_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      status: "done",
      trigger: "chat",
      title: "Задача",
      summary: "готово",
      threadId: chat.id,
    });
    expect((await store.chats.list()).find((c) => c.id === chat.id)?.busy).toBe(false);
  });

  it("marks the mail chat busy while a letter is being handled", async () => {
    const store = await tmpStore();
    const mail = await store.chats.ensureSystem();
    await store.saveRun({
      id: "run_mail",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      status: "running",
      trigger: "email",
      title: "Письмо",
      summary: "",
      threadId: "<msg@example.com>",
    });
    const listed = await store.chats.list();
    expect(listed.find((c) => c.id === mail.id)?.busy).toBe(true);
    expect(listed.find((c) => c.id === mail.id)?.kind).toBe("mail");
  });

  it("writes services.json world-readable for the hermes container", async () => {
    const prev = process.umask(0o077);
    try {
      const store = await tmpStore();
      await store.writeServices({ generatedAt: "t", recipes: [], credentials: [] });
      const mode = (await stat(path.join(store.root, "services.json"))).mode & 0o777;
      expect(mode).toBe(0o644);
    } finally {
      process.umask(prev);
    }
  });
});
