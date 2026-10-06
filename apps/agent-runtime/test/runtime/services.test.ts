import { describe, expect, it } from "vitest";
import { droppedCredentialSlugs } from "../../src/runtime/services";

describe("droppedCredentialSlugs", () => {
  it("возвращает слаги, которых нет в новом снимке", () => {
    expect(
      droppedCredentialSlugs(
        [{ slug: "linear" }, { slug: "notion" }],
        [{ slug: "notion" }],
      ),
    ).toEqual(["linear"]);
  });

  it("ничего не снимает, если секрет остался или снимка ещё не было", () => {
    expect(droppedCredentialSlugs([{ slug: "linear" }], [{ slug: "linear" }, { slug: "notion" }])).toEqual([]);
    expect(droppedCredentialSlugs(undefined, [{ slug: "linear" }])).toEqual([]);
  });
});
