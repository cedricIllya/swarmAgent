import { describe, expect, it, vi } from "vitest";
import {
  apiKeyPrompt,
  credentialHostAllowed,
  decideConnection,
  interpretApiKeyOutput,
  keyPageToStore,
  recipeWithKeyPage,
  looksLikeApiKey,
  looksLikeServiceApprovalWait,
  mailTouchesHost,
  parseAuthScheme,
  proofUrls,
  proofUrlsForService,
  proveApiKey,
  recipeAuth,
  serviceApprovalGranted,
  type ConnectFacts,
} from "../../src/onboarding/connect";

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

describe("apiKeyPrompt", () => {
  it("подсказка из рецепта каталога попадает в задачу, без неё строки нет", () => {
    const withHint = apiKeyPrompt({ agentName: "Бот", keyPageUrl: null, feedback: null, hint: "Токен из кабинета: Настройки → MCP." });
    expect(withHint).toContain("Что известно об этом продукте: Токен из кабинета: Настройки → MCP.");
    expect(apiKeyPrompt({ agentName: "Бот", keyPageUrl: null, feedback: null, hint: "  " })).not.toContain("Что известно");
  });

  it("записанную страницу открывает сразу и не отправляет искать раздел", () => {
    const prompt = apiKeyPrompt({
      agentName: "Бот",
      keyPageUrl: "https://app.acme.io/settings/tokens",
      remembered: true,
      feedback: null,
    });
    expect(prompt).toContain("открой https://app.acme.io/settings/tokens");
    expect(prompt).toContain("Другие разделы и документацию не открывай");
    expect(prompt).not.toContain("Смотри сайдбар");
  });
});

describe("keyPageToStore", () => {
  const anchors = ["https://app.acme.io/home", "acme.io"];

  it("оставляет страницу настроек своего сервиса", () => {
    expect(keyPageToStore("https://app.acme.io/settings/tokens#done", anchors)).toBe("https://app.acme.io/settings/tokens");
  });

  it("не запоминает корень, вход, приглашение, документацию и чужой сайт", () => {
    expect(keyPageToStore("https://app.acme.io/", anchors)).toBeNull();
    expect(keyPageToStore("https://app.acme.io/login", anchors)).toBeNull();
    expect(keyPageToStore("https://app.acme.io/invite/abc", anchors)).toBeNull();
    expect(keyPageToStore("https://app.acme.io/docs/api", anchors)).toBeNull();
    expect(keyPageToStore("https://evil.test/settings/tokens", anchors)).toBeNull();
  });

  it("выкидывает query, в котором лежит секрет", () => {
    expect(keyPageToStore("https://app.acme.io/settings/tokens?tab=api&token=sk_live_abcdefghijklmnopqrstuv", anchors)).toBe(
      "https://app.acme.io/settings/tokens",
    );
  });
});

describe("recipeWithKeyPage", () => {
  const recipe: { slug: string; browser?: { loginUrl: string; appUrl: string; keyPageUrl?: string } } = {
    slug: "acme",
    browser: { loginUrl: "https://app.acme.io/login", appUrl: "https://app.acme.io/" },
  };

  it("дописывает страницу и не переписывает ту же самую", () => {
    expect(recipeWithKeyPage(recipe, "https://app.acme.io/settings/tokens")?.browser?.keyPageUrl).toBe(
      "https://app.acme.io/settings/tokens",
    );
    const saved = {
      slug: "acme",
      browser: { loginUrl: "https://app.acme.io/login", appUrl: "https://app.acme.io/", keyPageUrl: "https://app.acme.io/settings/tokens" },
    };
    expect(recipeWithKeyPage(saved, "https://app.acme.io/settings/tokens")).toBeNull();
  });
});

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

describe("parseAuthScheme", () => {
  it("keeps the header name and drops the example token from the docs", () => {
    expect(parseAuthScheme("Authorization")).toEqual({ headerName: "Authorization", scheme: "Bearer" });
    expect(parseAuthScheme("Authorization: Bearer api_key")).toEqual({ headerName: "Authorization", scheme: "Bearer" });
    expect(parseAuthScheme("X-Api-Key: sk_live_example")).toEqual({ headerName: "X-Api-Key", scheme: null });
    expect(parseAuthScheme("не заголовок")).toBeNull();
    expect(recipeAuth("Authorization: Bearer api_key")).toEqual({ auth: "bearer", authHeader: "Authorization" });
    expect(recipeAuth("X-Api-Key")).toEqual({ auth: "header", authHeader: "X-Api-Key" });
  });
});

describe("proofUrlsForService", () => {
  it("does not prove a gensite MCP token against gitverse", () => {
    const service = ["https://gensite.ru/dashboard", "https://gensite.ru/api/mcp", "gensite.ru"];
    expect(
      proofUrlsForService(["https://gitverse.ru/api/v1/repos"], "https://gitverse.ru/api", service),
    ).toEqual([]);
    expect(
      proofUrlsForService(["https://gensite.ru/api/v1/me"], "https://gitverse.ru/api", service),
    ).toEqual(["https://gensite.ru/api/v1/me"]);
  });
});

describe("proofUrls", () => {
  it("uses a documented GET and skips the host root", () => {
    expect(proofUrls(["https://api.acme.io/v1/me"], "https://api.acme.io/")).toEqual(["https://api.acme.io/v1/me"]);
    expect(proofUrls([], "https://api.acme.io/")).toEqual([]);
    expect(proofUrls(["https://api.acme.io/users/{id}"], "https://api.acme.io/v1")).toEqual(["https://api.acme.io/v1"]);
  });
});

describe("proveApiKey", () => {
  it("is green when the request with the key returns 2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await proveApiKey({
      urls: ["https://api.acme.io/v1/me"],
      headerName: "Authorization: Bearer api_key",
      token: "secret-token-value",
      fetchImpl,
    });
    expect(r.verdict).toBe("green");
    expect(r.detail).toMatch(/ответил 200 с ключом/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: "Bearer secret-token-value" });
  });

  it("does not send a request when the header cannot be parsed", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await proveApiKey({
      urls: ["https://api.acme.io/v1/me"],
      headerName: "не заголовок",
      token: "secret-token-value",
      fetchImpl,
    });
    expect(r.verdict).toBe("not_tried");
    expect(fetchImpl).not.toHaveBeenCalled();
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
      reason: "Не получилось. Мы работаем над этим.",
    });
  });

  it("parks a registration that is waiting on the service admin and keeps the password", () => {
    const d = decideConnection(
      facts({
        onboard: "blocked",
        barrierKind: "pending_approval",
        notes: "Заявка на регистрацию ждёт одобрения",
        password: "pw-known-value",
      }),
    );
    expect(d).toMatchObject({ status: "escalated", park: true, savePassword: true, closeBrowser: true, saveToken: false });
  });

  it("treats a tool-bearing MCP as ready", () => {
    expect(decideConnection(facts({ mcpReady: true, password: null })).mode).toBe("mcp");
  });
});

describe("service approval wording", () => {
  it("hears a pending registration and not a granted one", () => {
    const waiting = "Подожду одобрение запроса на регистрацию в Gensite.";
    expect(looksLikeServiceApprovalWait(waiting)).toBe(true);
    expect(serviceApprovalGranted(waiting)).toBe(false);
    expect(serviceApprovalGranted("Ваша заявка одобрена")).toBe(true);
    expect(looksLikeServiceApprovalWait("одобрения владельца не нужно")).toBe(false);
  });

  it("matches mail from the service that is waiting", () => {
    expect(mailTouchesHost({ from: "Gensite <noreply@gensite.ru>", links: [] }, "https://gensite.ru/invite/1")).toBe(true);
    expect(mailTouchesHost({ from: "news@other.test", links: [] }, "https://gensite.ru/invite/1")).toBe(false);
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
