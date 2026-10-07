import { describe, expect, it } from "vitest";
import { mergeCredential, type ServiceCredential } from "@swarm/contracts";

const prev: ServiceCredential = {
  slug: "linear",
  kind: "browser",
  accountEmail: "agent@agents.test",
  accountName: "Агент",
  password: "secret",
  storageState: { provider: "local", profile: "acme" },
};

describe("mergeCredential", () => {
  it("keeps the saved login when a later report only adds a token", () => {
    const next = mergeCredential(prev, { slug: "linear", kind: "mcp", token: "tok" });
    expect(next.token).toBe("tok");
    expect(next.accountEmail).toBe("agent@agents.test");
    expect(next.accountName).toBe("Агент");
    expect(next.password).toBe("secret");
    expect(next.storageState).toEqual({ provider: "local", profile: "acme" });
  });

  it("keeps the tasks page when a later report does not send it", () => {
    const saved = mergeCredential(
      { ...prev, tasksUrl: "https://trello.com/u/me/cards" },
      { slug: "linear", kind: "browser", token: "tok" },
    );
    expect(saved.tasksUrl).toBe("https://trello.com/u/me/cards");
    expect(mergeCredential(saved, { slug: "linear", kind: "browser", tasksUrl: "" }).tasksUrl).toBe(
      "https://trello.com/u/me/cards",
    );
  });

  it("keeps the remembered list call and its digest", () => {
    const call = { kind: "api" as const, method: "GET" as const, url: "https://api.linear.app/graphql" };
    const saved = mergeCredential({ ...prev, tasksCall: call, tasksDigest: "a".repeat(64) }, { slug: "linear", kind: "api", token: "tok" });
    expect(saved.tasksCall).toEqual(call);
    expect(saved.tasksDigest).toBe("a".repeat(64));
  });
});
