import { describe, expect, it } from "vitest";
import type { ServiceRecipe, ServicesSnapshot } from "@swarm/contracts";
import { credentialVariables, maskVariables, referencedVariables, storedLoginAsked } from "./secrets";
import { pickPageToken } from "./save-token";

const gensite: ServiceRecipe = {
  slug: "gensite",
  name: "Gensite",
  kind: "mcp",
  domains: ["gensite.ru"],
  mcp: { url: "https://gensite.ru/api/mcp", transport: "streamable_http", auth: "bearer", includeTools: [] },
  notes: "",
  discoveredBy: null,
};

const services: ServicesSnapshot = {
  generatedAt: "t",
  recipes: [gensite],
  credentials: [{ slug: "gensite", kind: "mcp", token: "gs1.abc", accountEmail: "bot@agents.test", password: "s3cret-pass" }],
};

describe("secret variables", () => {
  it("finds only known placeholders", () => {
    expect(referencedVariables("введи %email% и %PASSWORD%, потом %foo%")).toEqual(["email", "password"]);
    expect(referencedVariables("нажми Войти")).toEqual([]);
  });

  it("takes values from the stored access and masks them back", () => {
    const vars = credentialVariables(services.credentials[0]);
    expect(vars).toEqual({ email: "bot@agents.test", password: "s3cret-pass" });
    expect(maskVariables("typed s3cret-pass into field", vars)).toBe("typed %password% into field");
  });

  it("rejects asking the owner for a password that is already stored", () => {
    expect(storedLoginAsked("Дай пароль для bot@agents.test, чтобы войти в gensite.ru", services)).toBe("gensite");
    expect(storedLoginAsked("Какой проект выбрать в Gensite?", services)).toBeNull();
    expect(storedLoginAsked("Дай пароль от Notion", services)).toBeNull();
  });
});

describe("pickPageToken", () => {
  it("keeps the first string the MCP server accepts", async () => {
    const pick = await pickPageToken(gensite, ["gs1.old", "gs1.new"], async (_r, t) => t === "gs1.new");
    expect(pick).toEqual({ token: "gs1.new", verified: true });
  });

  it("saves nothing when the server rejects every candidate", async () => {
    expect(await pickPageToken(gensite, ["gs1.a", "gs1.b"], async () => false)).toEqual({ token: null, rejected: 2 });
  });

  it("without MCP takes a token only when it is the only one on the page", async () => {
    const api: ServiceRecipe = { ...gensite, kind: "api", mcp: undefined };
    expect(await pickPageToken(api, ["k1"], async () => null)).toEqual({ token: "k1", verified: null });
    expect(await pickPageToken(api, ["k1", "k2"], async () => null)).toEqual({ token: null, rejected: 0 });
  });
});
