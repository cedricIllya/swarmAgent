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
});
