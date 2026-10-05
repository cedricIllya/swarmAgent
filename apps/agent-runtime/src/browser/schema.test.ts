import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PAGE_STATE_SCHEMA } from "./invite";
import { toExtractSchema } from "./schema";

describe("toExtractSchema", () => {
  it("turns the invite page schema into a Zod schema Stagehand recognises", () => {
    const s = toExtractSchema(PAGE_STATE_SCHEMA)!;
    expect(typeof s.parse).toBe("function");
    expect(typeof s.safeParse).toBe("function");
    expect(s.parse({ state: "email_form", hint: "поле e-mail" })).toEqual({ state: "email_form", hint: "поле e-mail" });
    expect(s.safeParse({ state: "nope", hint: "" }).success).toBe(false);
    expect(z.toJSONSchema(s)).toMatchObject({ type: "object", required: ["state", "hint"] });
  });

  it("passes Zod schemas through and leaves the schema-less call alone", () => {
    const own = z.object({ title: z.string() });
    expect(toExtractSchema(own)).toBe(own);
    expect(toExtractSchema(undefined)).toBeUndefined();
    expect(toExtractSchema(null)).toBeUndefined();
  });

  it("rejects things that are not a schema", () => {
    expect(() => toExtractSchema("string")).toThrow(/объектом/);
    expect(() => toExtractSchema({ type: "object", properties: { a: { type: "nonsense" } } })).toThrow(/не разобрана/);
  });
});
