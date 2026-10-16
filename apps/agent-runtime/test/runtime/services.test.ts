import { describe, expect, it } from "vitest";
import { createWriteLock, droppedCredentialSlugs } from "../../src/runtime/services";

describe("droppedCredentialSlugs", () => {
  it("возвращает слаги, которых нет в новом снимке", () => {
    expect(
      droppedCredentialSlugs(
        [{ slug: "linear" }, { slug: "notion" }],
        [{ slug: "notion" }],
      ),
    ).toEqual(["linear"]);
  });

  it("ничего не снимает, если секрет остался или снимка ещё не было", () => {
    expect(droppedCredentialSlugs([{ slug: "linear" }], [{ slug: "linear" }, { slug: "notion" }])).toEqual([]);
    expect(droppedCredentialSlugs(undefined, [{ slug: "linear" }])).toEqual([]);
  });
});

describe("createWriteLock", () => {
  it("держит вторую запись, пока первая не закончилась", async () => {
    const lock = createWriteLock();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lock(async () => {
      order.push("start1");
      await gate;
      order.push("end1");
    });
    const second = lock(async () => {
      order.push("start2");
    });
    await Promise.resolve();
    expect(order).toEqual(["start1"]);
    release();
    await first;
    await second;
    expect(order).toEqual(["start1", "end1", "start2"]);
  });
});
