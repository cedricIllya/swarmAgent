import { describe, expect, it } from "vitest";
import { parseThemePreference, resolveTheme } from "./theme";

describe("parseThemePreference", () => {
  it("keeps a known choice and falls back to the system", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("sepia")).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("follows an explicit choice", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system only when no choice is stored", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });
});
