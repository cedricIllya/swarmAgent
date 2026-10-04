import { describe, expect, it } from "vitest";
import {
  allocateLocalPart,
  localPartFromName,
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
