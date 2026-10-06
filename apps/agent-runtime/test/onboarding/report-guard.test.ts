import { describe, expect, it } from "vitest";
import { mergeCredential, type ServiceRecipe } from "@swarm/contracts";
import { guardCredentialReport, guardRecipeReport, mcpTokenCheck } from "../../src/onboarding/report-guard";

const gensite: ServiceRecipe = {
  slug: "gensite",
  name: "Gensite",
  kind: "mcp",
  domains: ["gensite.ru"],
  mcp: { url: "https://gensite.ru/api/mcp", transport: "streamable_http", auth: "bearer", includeTools: [] },
  notes: "Токен из кабинета.",
  discoveredBy: null,
};

describe("guardRecipeReport", () => {
  it("не пускает в рецепт адреса чужого сайта", () => {
    const r = guardRecipeReport(gensite, {
      ...gensite,
      browser: { loginUrl: "https://www.sprucely.io/oauth/auth", appUrl: "https://gensite.ru/" },
      notes: "Информация извлечена из документации Sprucely.io",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("sprucely.io");
  });

  it("известному рецепту оставляет ядро и заметки, принимает browser своего домена", () => {
    const r = guardRecipeReport(gensite, {
      ...gensite,
      kind: "browser",
      mcp: { url: "https://gensite.ru/other", transport: "sse", auth: "none", includeTools: [] },
      browser: { loginUrl: "https://gensite.ru/login", appUrl: "https://gensite.ru/" },
      notes: "что-то новое",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("mcp");
    expect(r.value.mcp?.url).toBe("https://gensite.ru/api/mcp");
    expect(r.value.notes).toBe("Токен из кабинета.");
    expect(r.value.browser?.appUrl).toBe("https://gensite.ru/");
    expect(r.note).toContain("оставлены прежними");
  });

  it("новый рецепт принимает целиком, если адреса одного бренда", () => {
    const r = guardRecipeReport(null, {
      slug: "linear",
      name: "Linear",
      kind: "mcp",
      domains: ["linear.app"],
      mcp: { url: "https://mcp.linear.app/mcp", transport: "streamable_http", auth: "oauth", includeTools: [] },
      notes: "",
      discoveredBy: null,
    });
    expect(r.ok).toBe(true);
  });
});

describe("guardCredentialReport", () => {
  it("отвергает заглушку и токен, который MCP не принял", async () => {
    const stub = await guardCredentialReport(gensite, { slug: "gensite", kind: "mcp", token: "gs1.<твой токен>" }, async () => true);
    expect(stub.ok).toBe(false);
    const rejected = await guardCredentialReport(gensite, { slug: "gensite", kind: "mcp", token: "gs1.abcdefghijklmnop" }, async () => false);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toContain("не принял");
  });

  it("принимает токен, который сервер подтвердил или не смог проверить", async () => {
    const ok = await guardCredentialReport(gensite, { slug: "gensite", kind: "mcp", token: "gs1.abcdefghijklmnop" }, async () => true);
    expect(ok.ok).toBe(true);
    const unknown = await guardCredentialReport(gensite, { slug: "gensite", kind: "mcp", token: "gs1.abcdefghijklmnop" }, async () => null);
    expect(unknown.ok).toBe(true);
    const pw = await guardCredentialReport(gensite, { slug: "gensite", kind: "browser", password: "p" }, async () => false);
    expect(pw.ok).toBe(true);
  });
});

describe("mergeCredential с token: null", () => {
  it("убирает сохранённый токен, остальное оставляет", () => {
    const prev = { slug: "gensite", kind: "browser" as const, token: "gs1.old", password: "p", accountEmail: "a@b.c" };
    const merged = mergeCredential(prev, { slug: "gensite", kind: "browser", token: null });
    expect("token" in merged).toBe(false);
    expect(merged.password).toBe("p");
    expect(merged.accountEmail).toBe("a@b.c");
    expect(mergeCredential(prev, { slug: "gensite", kind: "browser" }).token).toBe("gs1.old");
  });
});

describe("mcpTokenCheck", () => {
  it("401 на initialize — токен не принят", async () => {
    const fetchImpl = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(mcpTokenCheck(gensite, "gs1.x", fetchImpl)).resolves.toBe(false);
  });

  it("сетевой сбой — неизвестно", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(mcpTokenCheck(gensite, "gs1.x", fetchImpl)).resolves.toBeNull();
  });
});
