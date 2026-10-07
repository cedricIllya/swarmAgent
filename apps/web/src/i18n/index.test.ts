import { describe, expect, it } from "vitest";
import { count, t } from "./index";

describe("english copy", () => {
  it("reads the default locale and fills placeholders", () => {
    expect(t("common.email")).toBe("Email");
    expect(t("common.countOf", { count: 2, total: 5 })).toBe("2 of 5");
  });

  it("uses english plurals", () => {
    expect(count(1, "tasks")).toBe("1 task");
    expect(count(3, "agents")).toBe("3 agents");
  });
});
