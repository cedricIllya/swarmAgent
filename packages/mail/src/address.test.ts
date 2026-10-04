import { describe, expect, it } from "vitest";
import {
  allocateLocalPart,
  localPartForOwner,
  localPartFromName,
  loginFromEmail,
  parseAddress,
  validateLocalPart,
  withSuffix,
} from "./address";

describe("localPartFromName", () => {
  it("transliterates cyrillic and joins words with dots", () => {
    expect(localPartFromName("Владимир Ленин")).toBe("vladimir.lenin");
  });
  it("lowercases and strips diacritics", () => {
    expect(localPartFromName("Zoë  Müller")).toBe("zoe.muller");
  });
  it("replaces junk inside a word with hyphens", () => {
    expect(localPartFromName("Ops/Bot (v2)")).toBe("ops-bot.v2");
  });
  it("falls back to agent", () => {
    expect(localPartFromName("")).toBe("agent");
    expect(localPartFromName("   ---  ")).toBe("agent");
  });
});

describe("loginFromEmail", () => {
  it("takes the local part, lowercased, without plus tag", () => {
    expect(loginFromEmail("John.Doe+work@corp.com")).toBe("john.doe");
  });
  it("keeps dots, hyphens and underscores, replaces the rest", () => {
    expect(loginFromEmail("ops_bot-1@x.io")).toBe("ops_bot-1");
    expect(loginFromEmail("иван!петров@x.io")).toBe("ivan-petrov");
  });
  it("collapses repeated separators and trims edges", () => {
    expect(loginFromEmail(".a..b-@x.io")).toBe("a.b");
  });
  it("caps length and falls back to user", () => {
    expect(loginFromEmail("a".repeat(50) + "@x.io")).toBe("a".repeat(32));
    expect(loginFromEmail("+tag@x.io")).toBe("user");
  });
});

describe("localPartForOwner", () => {
  it("prefixes the agent name with the owner login", () => {
    expect(localPartForOwner("cedric@gmail.com", "Владимир Ленин")).toBe("cedric.vladimir.lenin");
  });
  it("differs for the same agent name under different owners", () => {
    expect(localPartForOwner("alice@x.io", "Ops")).not.toBe(localPartForOwner("bob@x.io", "Ops"));
  });
  it("leaves room for a collision suffix inside 64 chars", () => {
    const got = localPartForOwner("a".repeat(40) + "@x.io", "b".repeat(80));
    expect(got.length).toBeLessThanOrEqual(60);
    expect(validateLocalPart(withSuffix(got, 999))).toBeNull();
    expect(got.startsWith("a".repeat(32) + ".")).toBe(true);
  });
  it("falls back to agent for an empty name", () => {
    expect(localPartForOwner("cedric@gmail.com", "   ")).toBe("cedric.agent");
  });
});

describe("suffix", () => {
  it("adds numeric suffix without extra dot", () => {
    expect(withSuffix("vladimir.lenin", 1)).toBe("vladimir.lenin");
    expect(withSuffix("vladimir.lenin", 2)).toBe("vladimir.lenin2");
  });
  it("allocates the first free candidate", async () => {
    const taken = new Set(["vladimir.lenin", "vladimir.lenin2"]);
    const got = await allocateLocalPart("vladimir.lenin", async (c) => taken.has(c));
    expect(got).toBe("vladimir.lenin3");
  });
});

describe("validateLocalPart", () => {
  it("accepts allowed chars", () => {
    expect(validateLocalPart("ops_bot.v2-x")).toBeNull();
  });
  it("rejects others", () => {
    expect(validateLocalPart("ops bot")).not.toBeNull();
    expect(validateLocalPart("ops+bot")).not.toBeNull();
  });
});

describe("parseAddress", () => {
  it("strips display name and plus tag", () => {
    expect(parseAddress('"Agent" <Name+G@Domain.com>')).toEqual({
      localPart: "name",
      tag: "G",
      domain: "domain.com",
    });
  });
  it("returns null for junk", () => {
    expect(parseAddress("nope")).toBeNull();
  });
});
