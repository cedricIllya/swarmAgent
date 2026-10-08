import { describe, expect, it } from "vitest";
import { browserFailure, chromePidsFromPs, desktopUserAgent, pageReading, settlePage, tokenCandidates } from "../../src/browser/stagehand";
import { acquireProfile } from "../../src/browser/profile-lock";

describe("tokenCandidates", () => {
  it("находит длинные ключи и пропускает адреса и слова", () => {
    const text = [
      "Authorization: Bearer gs1.eyJhbGciOiJIUzI1NiJ9.abcdef0123456789",
      "Документация: https://gensite.ru/docs/mcp/very-long-path-name",
      "Напишите на support@gensite.ru или прочитайте инструкциюпоподключению",
      "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    ].join("\n");
    const found = tokenCandidates(text);
    expect(found).toContain("gs1.eyJhbGciOiJIUzI1NiJ9.abcdef0123456789");
    expect(found).toContain("sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(found.some((t) => t.includes("gensite.ru"))).toBe(false);
    expect(found.some((t) => t.includes("инструкцию"))).toBe(false);
  });

  it("pageReading собирает токены из полей раньше текста, без повторов", () => {
    const r = pageReading("https://x/settings", "токен: gs1.aaaaaaaaaaaaaaaaaaaaaaaa", [
      { label: "Config", value: '{"Authorization":"Bearer gs1.aaaaaaaaaaaaaaaaaaaaaaaa"}' },
    ]);
    expect(r.tokens).toEqual(["gs1.aaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(r.fields).toHaveLength(1);
  });
});

describe("acquireProfile", () => {
  it("второй захват ждёт освобождения первого, таймаут — ошибка", async () => {
    const release = await acquireProfile("/tmp/p1");
    let second = false;
    const waiting = acquireProfile("/tmp/p1").then((r) => {
      second = true;
      r();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    release();
    await waiting;
    expect(second).toBe(true);
    const hold = await acquireProfile("/tmp/p2");
    await expect(acquireProfile("/tmp/p2", 30)).rejects.toThrow("занят");
    hold();
  });
});

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

  it("зависшая оценка страницы отпускается в пределах бюджета", async () => {
    const page = {
      async waitForLoadState() {},
      evaluate: <R,>() => new Promise<R>(() => {}),
      async waitForTimeout() {},
    };
    const started = Date.now();
    await settlePage(page, { network: false, budgetMs: 350 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("browserFailure", () => {
  it("обрыв сети и ошибка вкладки — новая вкладка, мёртвый Chromium — новый запуск", () => {
    expect(browserFailure(new Error("net::ERR_ABORTED"))).toBe("retry-page");
    expect(browserFailure(new Error("страница не открылась: chrome-error://chromewebdata/"))).toBe("retry-page");
    expect(browserFailure(new Error("RPC response timed out: page.goto"))).toBe("retry-page");
    expect(browserFailure(new Error("Chrome exited before its debugging port was ready with code 21"))).toBe("relaunch");
    expect(browserFailure(new Error("launch: шаг браузера не завершился за 45 с"))).toBe("relaunch");
    expect(browserFailure(new Error("Stagehand initialization timed out after 60000ms"))).toBe("relaunch");
    expect(browserFailure(new Error("ERR_NAME_NOT_RESOLVED"))).toBe("fatal");
    expect(browserFailure(new Error("Сессия браузера закрыта"))).toBe("fatal");
  });
});

describe("chromePidsFromPs", () => {
  it("берёт только Chromium с этим профилем", () => {
    const out = [
      "  10 /usr/bin/chromium --user-data-dir=/data/browser-profiles/trello",
      "  11 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/data/browser-profiles/other",
      "  12 node /data/browser-profiles/trello/server.js",
    ].join("\n");
    expect(chromePidsFromPs(out, "/data/browser-profiles/trello")).toEqual([10]);
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
