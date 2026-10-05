import { describe, expect, it, vi } from "vitest";
import {
  currentUrlFromCdp,
  exportStorageFromCdp,
  seedStorageIntoProfile,
  transferSessionToProfile,
  type BrowserStorageState,
} from "./session-transfer";

const sampleState: BrowserStorageState = {
  cookies: [
    {
      name: "session",
      value: "abc",
      domain: "app.acme.io",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [
    {
      origin: "https://app.acme.io",
      localStorage: [{ name: "token", value: "t1" }],
    },
  ],
};

describe("exportStorageFromCdp", () => {
  it("reads storageState from the first browser context and closes", async () => {
    const close = vi.fn(async () => undefined);
    const storageState = vi.fn(async () => sampleState);
    const connect = vi.fn(async () => ({
      contexts: () => [{ storageState }],
      newContext: vi.fn(),
      close,
    }));
    const state = await exportStorageFromCdp({
      cdpUrl: "wss://sessions.skyvern.com/pbs_1",
      apiKey: "key",
      connect: connect as never,
    });
    expect(connect).toHaveBeenCalledWith("wss://sessions.skyvern.com/pbs_1", {
      headers: { "x-api-key": "key" },
      timeout: 20_000,
    });
    expect(state.cookies).toHaveLength(1);
    expect(state.origins[0]?.localStorage).toEqual([{ name: "token", value: "t1" }]);
    expect(close).toHaveBeenCalled();
  });
});

describe("currentUrlFromCdp", () => {
  it("возвращает адрес последней http-вкладки и отключается", async () => {
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({
      contexts: () => [{ pages: () => [{ url: () => "about:blank" }, { url: () => "https://gensite.ru/dashboard" }] }],
      close,
    }));
    await expect(currentUrlFromCdp({ cdpUrl: "wss://x", connect: connect as never })).resolves.toBe("https://gensite.ru/dashboard");
    expect(close).toHaveBeenCalled();
    const empty = vi.fn(async () => ({ contexts: () => [{ pages: () => [{ url: () => "about:blank" }] }], close }));
    await expect(currentUrlFromCdp({ cdpUrl: "wss://x", connect: empty as never })).resolves.toBeNull();
  });
});

describe("seedStorageIntoProfile", () => {
  it("adds cookies and writes localStorage per origin", async () => {
    const addCookies = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => undefined);
    const goto = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const page = { goto, evaluate };
    const launch = vi.fn(async () => ({
      addCookies,
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close,
    }));
    await seedStorageIntoProfile({
      profileDir: "/tmp/swarm-profile-test",
      state: sampleState,
      executablePath: "/usr/bin/chromium",
      launch: launch as never,
    });
    expect(launch).toHaveBeenCalled();
    expect(addCookies).toHaveBeenCalledWith(sampleState.cookies);
    expect(goto).toHaveBeenCalledWith("https://app.acme.io", expect.any(Object));
    expect(evaluate).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});

describe("transferSessionToProfile", () => {
  it("exports then seeds and returns counts", async () => {
    const closeBrowser = vi.fn(async () => undefined);
    const closeContext = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({
      contexts: () => [{ storageState: async () => sampleState }],
      newContext: vi.fn(),
      close: closeBrowser,
    }));
    const launch = vi.fn(async () => ({
      addCookies: vi.fn(async () => undefined),
      pages: () => [{ goto: vi.fn(async () => undefined), evaluate: vi.fn(async () => undefined) }],
      newPage: vi.fn(),
      close: closeContext,
    }));
    const stats = await transferSessionToProfile({
      cdpUrl: "wss://example/cdp",
      apiKey: "k",
      profileDir: "/tmp/swarm-profile-transfer",
      executablePath: "/usr/bin/chromium",
      connect: connect as never,
      launch: launch as never,
    });
    expect(stats).toEqual({ cookies: 1, origins: 1 });
  });

  it("rejects an empty session", async () => {
    const connect = vi.fn(async () => ({
      contexts: () => [{ storageState: async () => ({ cookies: [], origins: [] }) }],
      newContext: vi.fn(),
      close: vi.fn(async () => undefined),
    }));
    await expect(
      transferSessionToProfile({
        cdpUrl: "wss://example/cdp",
        apiKey: "k",
        profileDir: "/tmp/empty",
        executablePath: "/usr/bin/chromium",
        connect: connect as never,
      }),
    ).rejects.toThrow(/нет cookies/);
  });
});
