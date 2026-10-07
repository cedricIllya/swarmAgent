import { describe, expect, it } from "vitest";
import { serviceFromDomain, titleMark, workMarks } from "../../src/tasks/work-marks";

describe("workMarks", () => {
  it("reads a ticket and a card url, and ignores the service home", () => {
    const marks = workMarks([
      "Назначили LIN-12",
      "https://linear.app/acme/issue/LIN-12/fix-the-bug",
      "https://linear.app/acme/inbox",
      "кодировка UTF-8",
    ]);
    expect(marks).toContain("ticket:LIN-12");
    expect(marks).toContain("url:linear.app/acme/issue/lin-12");
    expect(marks.some((mark) => mark.includes("inbox"))).toBe(false);
    expect(marks.some((mark) => mark.includes("UTF"))).toBe(false);
  });

  it("treats the same github issue with and without a slug as one url", () => {
    const a = workMarks(["https://github.com/org/repo/issues/12"]);
    const b = workMarks(["https://github.com/org/repo/issues/12/title"]);
    expect(a).toEqual(b);
  });
});

describe("titleMark", () => {
  it("drops the service prefix and Re:", () => {
    expect(titleMark("linear: Починить баг", "linear")).toBe("title:linear:починить баг");
    expect(titleMark("Re: Починить баг", "Linear")).toBe("title:linear:починить баг");
  });

  it("does not glue the same words from two services", () => {
    expect(titleMark("notion: Починить баг", "notion")).toBe("title:notion:починить баг");
  });
});

describe("serviceFromDomain", () => {
  it("uses the product label", () => {
    expect(serviceFromDomain("linear.app")).toBe("linear");
    expect(serviceFromDomain("mail.linear.app")).toBe("linear");
  });
});
