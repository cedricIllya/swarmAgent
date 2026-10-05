import { describe, expect, it } from "vitest";
import { desktopUserAgent, settlePage } from "./stagehand";

function fakePage(texts: boolean[], opts: { networkIdleRejects?: boolean } = {}) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    page: {
      async waitForLoadState(state: string) {
        calls.push(`load:${state}`);
        if (opts.networkIdleRejects) throw new Error("timeout");
      },
      async evaluate<R>(): Promise<R> {
        calls.push("text");
        const v = texts[Math.min(i, texts.length - 1)] ?? true;
        i += 1;
        return v as R;
      },
      async waitForTimeout(ms: number) {
        calls.push(`sleep:${ms}`);
      },
    },
  };
}

describe("settlePage", () => {
  it("после перехода ждёт затишья сети и первого текста", async () => {
    const f = fakePage([false, false, true]);
    await settlePage(f.page, { network: true });
    expect(f.calls[0]).toBe("load:networkidle");
    expect(f.calls.filter((c) => c === "text")).toHaveLength(3);
    expect(f.calls.filter((c) => c.startsWith("sleep"))).toHaveLength(2);
  });

  it("страница с текстом не ждёт ничего лишнего", async () => {
    const f = fakePage([true]);
    await settlePage(f.page, { network: false });
    expect(f.calls).toEqual(["text"]);
  });

  it("таймаут networkidle не ошибка, пустая страница отпускается по бюджету", async () => {
    const f = fakePage([false], { networkIdleRejects: true });
    await settlePage(f.page, { network: true, budgetMs: 1 });
    expect(f.calls[0]).toBe("load:networkidle");
    expect(f.calls.filter((c) => c === "text").length).toBeGreaterThan(0);
  });
});

describe("desktopUserAgent", () => {
  it("берёт мажорную версию из вывода --version", () => {
    expect(desktopUserAgent("Chromium 131.0.6778.85")).toContain("Chrome/131.0.0.0");
  });

  it("без версии — null", () => {
    expect(desktopUserAgent("nope")).toBeNull();
  });
});
