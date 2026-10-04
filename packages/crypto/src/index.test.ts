import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptJson, decryptString, encryptJson, encryptString, safeEqual } from "./index";

const key = randomBytes(32);

describe("crypto", () => {
  it("round-trips a string", () => {
    const enc = encryptString("пароль с юникодом 🙂", key);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decryptString(enc, key)).toBe("пароль с юникодом 🙂");
  });

  it("round-trips json", () => {
    const enc = encryptJson({ a: 1, b: ["x"] }, key);
    expect(decryptJson(enc, key)).toEqual({ a: 1, b: ["x"] });
  });

  it("rejects tampered payloads", () => {
    const enc = encryptString("x", key);
    const parts = enc.split(".");
    parts[3] = "AAAA";
    expect(() => decryptString(parts.join("."), key)).toThrow();
  });

  it("safeEqual handles non-ascii and different lengths", () => {
    expect(safeEqual("тест", "тест")).toBe(true);
    expect(safeEqual("тест", "тес")).toBe(false);
    expect(safeEqual("a", "b")).toBe(false);
  });
});
