import { describe, expect, it } from "vitest";
import { partitionTaskLog, runListKey, transferRunKey, waitingOnPerson, type TaskLogTone } from "./task-log-list";

function item(key: string, tone: TaskLogTone) {
  return { key, tone, value: key };
}

describe("ключ строки журнала", () => {
  it("переносит ключ заготовки на настоящий прогон и повтор того же переноса ничего не меняет", () => {
    const keys = new Map<string, string>();
    expect(runListKey(keys, "local_a")).toBe("local_a");
    transferRunKey(keys, "local_a", "run_1");
    transferRunKey(keys, "local_a", "run_1");
    expect(runListKey(keys, "run_1")).toBe("local_a");
    expect(keys.has("local_a")).toBe(false);
  });
});

describe("ожидание человека", () => {
  it("считает задачу в работе, пока человек не решил", () => {
    expect(waitingOnPerson("escalated", false)).toBe(true);
    expect(waitingOnPerson("waiting_approval", false)).toBe(true);
    expect(waitingOnPerson("done", true)).toBe(true);
    expect(waitingOnPerson("done", false)).toBe(false);
    expect(waitingOnPerson("failed", false)).toBe(false);
    expect(waitingOnPerson("running", false)).toBe(false);
  });
});

describe("секции журнала", () => {
  it("оставляет открытую задачу на месте, когда она завершается", () => {
    const pinned = new Map<string, "attention" | "live">();
    const open = new Set(["live"]);
    const first = partitionTaskLog(
      [item("live", "live"), item("old", "settled")],
      (key) => open.has(key),
      pinned,
    );
    expect(first.top).toEqual(["live"]);
    expect(first.archive).toEqual(["old"]);

    const done = partitionTaskLog(
      [item("live", "settled"), item("old", "settled")],
      (key) => open.has(key),
      pinned,
    );
    expect(done.top).toEqual(["live"]);
    expect(done.archive).toEqual(["old"]);
  });

  it("уводит задачу в архив только после того, как её закрыли", () => {
    const pinned = new Map<string, "attention" | "live">([["live", "live"]]);
    const closed = partitionTaskLog(
      [item("live", "settled"), item("old", "settled")],
      () => false,
      pinned,
    );
    expect(closed.top).toEqual([]);
    expect(closed.archive).toEqual(["live", "old"]);
  });

  it("не вытаскивает завершённую задачу из архива, если её открыли уже там", () => {
    const pinned = new Map<string, "attention" | "live">();
    const opened = partitionTaskLog([item("old", "settled")], () => true, pinned);
    expect(opened.top).toEqual([]);
    expect(opened.archive).toEqual(["old"]);
  });
});
