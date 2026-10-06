import { describe, expect, it } from "vitest";
import type { ServicesSnapshot } from "@swarm/contracts";
import { savedBrowserSlug } from "./local-session";

const services: ServicesSnapshot = {
  generatedAt: "t",
  recipes: [
    {
      slug: "pneumatic",
      name: "Pneumatic",
      kind: "browser",
      domains: ["pneumatic.app"],
      browser: { loginUrl: "https://my.pneumatic.app/", appUrl: "https://my.pneumatic.app/" },
      notes: "",
      discoveredBy: null,
    },
  ],
  credentials: [
    {
      slug: "pneumatic",
      kind: "browser",
      accountEmail: "bot@agents.test",
      password: "pw",
      storageState: { provider: "local", profile: "pneumatic" },
    },
  ],
};

describe("savedBrowserSlug", () => {
  it("finds the local profile for a host of a connected service", () => {
    expect(savedBrowserSlug(services, "https://my.pneumatic.app/")).toBe("pneumatic");
  });

  it("does not treat a service without a transferred session as already open", () => {
    const fresh: ServicesSnapshot = {
      ...services,
      credentials: [{ slug: "pneumatic", kind: "browser", password: "pw" }],
    };
    expect(savedBrowserSlug(fresh, "https://my.pneumatic.app/")).toBeNull();
    expect(savedBrowserSlug(services, "https://trello.com/")).toBeNull();
    expect(savedBrowserSlug(null, "https://my.pneumatic.app/")).toBeNull();
  });
});
