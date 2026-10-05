import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Cookie } from "playwright-core";
import { log, warn } from "../log";

/**
 * Перенос cookies/localStorage из живой сессии Skyvern (CDP) в профиль своего Chromium.
 * Пароль остаётся запасным входом, если сервис привязал сессию к IP прокси.
 */

export interface StorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface BrowserStorageState {
  cookies: Cookie[];
  origins: StorageOrigin[];
}

export type ConnectOverCdp = (
  endpointURL: string,
  options?: { headers?: Record<string, string>; timeout?: number },
) => Promise<Browser>;

export type LaunchPersistent = (
  userDataDir: string,
  options?: {
    executablePath?: string;
    headless?: boolean;
    args?: string[];
    chromiumSandbox?: boolean;
  },
) => Promise<BrowserContext>;

function defaultConnect(): ConnectOverCdp {
  return (url, opts) => chromium.connectOverCDP(url, opts);
}

function defaultLaunch(): LaunchPersistent {
  return (dir, opts) => chromium.launchPersistentContext(dir, opts);
}

/** Снять Playwright storageState с уже открытого браузера по CDP. */
export async function exportStorageFromCdp(args: {
  cdpUrl: string;
  apiKey?: string;
  connect?: ConnectOverCdp;
  timeoutMs?: number;
}): Promise<BrowserStorageState> {
  const connect = args.connect ?? defaultConnect();
  const browser = await connect(args.cdpUrl, {
    ...(args.apiKey ? { headers: { "x-api-key": args.apiKey } } : {}),
    timeout: args.timeoutMs ?? 20_000,
  });
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const state = await context.storageState();
    return {
      cookies: state.cookies as Cookie[],
      origins: (state.origins ?? []).map((o) => ({
        origin: o.origin,
        localStorage: o.localStorage ?? [],
      })),
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Записать cookies и localStorage в userDataDir своего Chromium. */
export async function seedStorageIntoProfile(args: {
  profileDir: string;
  state: BrowserStorageState;
  executablePath: string;
  launch?: LaunchPersistent;
}): Promise<void> {
  await mkdir(args.profileDir, { recursive: true });
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await rm(path.join(args.profileDir, name), { force: true }).catch(() => undefined);
  }
  const launch = args.launch ?? defaultLaunch();
  const context = await launch(args.profileDir, {
    executablePath: args.executablePath,
    headless: true,
    chromiumSandbox: process.getuid?.() !== 0,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
  });
  try {
    if (args.state.cookies.length) {
      await context.addCookies(args.state.cookies);
    }
    for (const origin of args.state.origins) {
      if (!origin.localStorage.length) continue;
      let page = context.pages()[0];
      if (!page) page = await context.newPage();
      try {
        await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.evaluate((items) => {
          for (const { name, value } of items) localStorage.setItem(name, value);
        }, origin.localStorage);
      } catch (e) {
        warn("session-transfer", "localStorage не записан", { origin: origin.origin, error: String(e) });
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function transferSessionToProfile(args: {
  cdpUrl: string;
  apiKey: string;
  profileDir: string;
  executablePath: string;
  connect?: ConnectOverCdp;
  launch?: LaunchPersistent;
}): Promise<{ cookies: number; origins: number }> {
  const state = await exportStorageFromCdp({
    cdpUrl: args.cdpUrl,
    apiKey: args.apiKey,
    ...(args.connect ? { connect: args.connect } : {}),
  });
  return applyStorageToProfile({
    state,
    profileDir: args.profileDir,
    executablePath: args.executablePath,
    ...(args.launch ? { launch: args.launch } : {}),
  });
}

/** Уже снятый storageState → профиль своего Chromium. */
export async function applyStorageToProfile(args: {
  state: BrowserStorageState;
  profileDir: string;
  executablePath: string;
  launch?: LaunchPersistent;
}): Promise<{ cookies: number; origins: number }> {
  if (!args.state.cookies.length && !args.state.origins.some((o) => o.localStorage.length)) {
    throw new Error("в сессии Skyvern нет cookies и localStorage");
  }
  await seedStorageIntoProfile({
    profileDir: args.profileDir,
    state: args.state,
    executablePath: args.executablePath,
    ...(args.launch ? { launch: args.launch } : {}),
  });
  log("session-transfer", "сессия перенесена в профиль", {
    profileDir: args.profileDir,
    cookies: args.state.cookies.length,
    origins: args.state.origins.length,
  });
  return { cookies: args.state.cookies.length, origins: args.state.origins.length };
}
