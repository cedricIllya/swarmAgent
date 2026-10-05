import { describe, expect, it, vi } from "vitest";
import {
  credentialHostAllowed,
  decideConnection,
  interpretApiKeyOutput,
  looksLikeApiKey,
  proveApiKey,
  type ConnectFacts,
} from "./connect";

function facts(patch: Partial<ConnectFacts> = {}): ConnectFacts {
  return {
    onboard: "landed",
    inviteUrl: "https://app.acme.io/invite/abc",
    landedUrl: "https://app.acme.io/home",
    passwordTyped: true,
    password: "pw-known-value",
    barrierKind: null,
    notes: "",
    apiBaseUrl: null,
    apiKeyUsable: false,
    proof: "not_tried",
    mcpReady: false,
    ...patch,
  };
}

describe("credentialHostAllowed", () => {
  it("allows the invite host and its siblings", () => {
    expect(credentialHostAllowed("https://api.acme.io/v1/me", ["https://app.acme.io/invite/abc"])).toBe(true);
  });

  it("rejects a different brand and a neighbour on a shared suffix", () => {
    expect(credentialHostAllowed("https://evil.test/me", ["https://app.acme.io/invite/abc"])).toBe(false);
    expect(credentialHostAllowed("https://evil.herokuapp.com/me", ["https://acme.herokuapp.com/invite"])).toBe(false);
    expect(credentialHostAllowed("https://acme.herokuapp.com/me", ["https://acme.herokuapp.com/invite"])).toBe(true);
  });
});

describe("looksLikeApiKey", () => {
  it("rejects masks, short values and whitespace", () => {
    expect(looksLikeApiKey("sk_live_abc").ok).toBe(false);
    expect(looksLikeApiKey("sk_live_••••••••••••abcd").ok).toBe(false);
    expect(looksLikeApiKey("sk_live_abcdefghijklmnop q").ok).toBe(false);
    expect(looksLikeApiKey("sk_live_abcdefghijklmnop").ok).toBe(true);
  });
});

describe("proveApiKey", () => {
  it("is green only when the same path fails without the key", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const status = init?.headers ? 200 : 401;
      return new Response("ok", { status });
    }) as unknown as typeof fetch;
    const r = await proveApiKey({
      urls: ["https://api.acme.io/v1/me"],
      headerName: "Authorization",
      token: "secret-token-value",
      fetchImpl,
    });
    expect(r.verdict).toBe("green");
  });

  it("does not treat a public 200 as proof", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await proveApiKey({
      urls: ["https://api.acme.io/v1/me"],
      headerName: "Authorization",
      token: "secret-token-value",
      fetchImpl,
    });
    expect(r.verdict).toBe("inconclusive");
  });

  it("a 401 with the key is a refusal, a 503 is not", async () => {
    const refused = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    expect(
      (await proveApiKey({ urls: ["https://api.acme.io/v1/me"], headerName: "X-Api-Key", token: "secret-token-value", fetchImpl: refused })).verdict,
    ).toBe("refused");
    const down = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(
      (await proveApiKey({ urls: ["https://api.acme.io/v1/me"], headerName: "X-Api-Key", token: "secret-token-value", fetchImpl: down })).verdict,
    ).toBe("inconclusive");
  });
});

describe("decideConnection", () => {
  it("does not call an unproven key a connection, but a password still is", () => {
    const d = decideConnection(facts({ apiKeyUsable: true, apiBaseUrl: "https://api.acme.io", proof: "refused" }));
    expect(d).toMatchObject({ status: "ready", mode: "browser", saveToken: false, savePassword: true });
    expect(d.reason).toMatch(/ключ создан, но вызов/);
  });

  it("requires a proven call for api mode", () => {
    expect(decideConnection(facts({ apiKeyUsable: true, apiBaseUrl: "https://api.acme.io", proof: "green", password: null }))).toMatchObject({
      status: "ready",
      mode: "api",
      saveToken: true,
    });
    expect(decideConnection(facts({ apiKeyUsable: true, apiBaseUrl: null, proof: "not_tried", password: null })).reason).toMatch(/базовый URL/);
  });

  it("drops a password that was typed on the wrong domain", () => {
    const d = decideConnection(facts({ landedUrl: "https://evil.test/home" }));
    expect(d).toMatchObject({ status: "escalated", savePassword: false, saveToken: false, closeBrowser: true });
  });

  it("keeps the browser open on a product barrier and closes it on our outage", () => {
    expect(decideConnection(facts({ onboard: "blocked", barrierKind: "sso_only", notes: "только SSO" }))).toMatchObject({
      status: "escalated",
      closeBrowser: false,
    });
    expect(decideConnection(facts({ onboard: "runtime", notes: "Skyvern 429" }))).toMatchObject({
      status: "failed",
      closeBrowser: true,
    });
  });

  it("treats a tool-bearing MCP as ready", () => {
    expect(decideConnection(facts({ mcpReady: true, password: null })).mode).toBe("mcp");
  });
});

describe("interpretApiKeyOutput", () => {
  it("drops a masked key and keeps a real one", () => {
    expect(interpretApiKeyOutput({ api_key: "sk_live_••••abcd", notes: "shown" }).found).toBe(false);
    expect(interpretApiKeyOutput({ api_key: "sk_live_abcdefghijklmnop", key_outcome: "created" })).toMatchObject({
      found: true,
      outcome: "created",
    });
  });
});
