import { describe, expect, it } from "vitest";
import { classifyReply, findDigitCode, matchesThread } from "./approval";

describe("classifyReply", () => {
  it("approves short yes words", () => {
    expect(classifyReply("Да")).toBe("approve");
    expect(classifyReply("yes.")).toBe("approve");
    expect(classifyReply("ОК!")).toBe("approve");
  });
  it("rejects short no words", () => {
    expect(classifyReply("нет")).toBe("reject");
    expect(classifyReply("No")).toBe("reject");
  });
  it("treats longer text as a task", () => {
    expect(classifyReply("да, но сначала проверь")).toBe("task");
    expect(classifyReply("создай задачу в Linear")).toBe("task");
  });
});

describe("matchesThread", () => {
  it("matches in-reply-to or references", () => {
    const sent = ["<a@x>", "<b@x>"];
    expect(matchesThread({ inReplyTo: "<a@x>", references: [] }, sent)).toBe("<a@x>");
    expect(matchesThread({ inReplyTo: null, references: ["<z@x>", "<b@x>"] }, sent)).toBe("<b@x>");
    expect(matchesThread({ inReplyTo: "<q@x>", references: [] }, sent)).toBeNull();
  });
});

describe("findDigitCode", () => {
  it("finds a standalone code", () => {
    expect(findDigitCode("Your code is 482913. It expires soon")).toBe("482913");
    expect(findDigitCode("Order 2024-11-05 shipped")).toBeNull();
  });

  it("finds Atlassian/Trello codes with spaces or in the subject", () => {
    expect(findDigitCode("Verify your identity\n\n4 8 2 9 1 3\n\nExpires soon")).toBe("482913");
    expect(findDigitCode("482913 is your verification code")).toBe("482913");
    expect(findDigitCode("Your verification code is:\n8 3 1 0 4 2")).toBe("831042");
  });
});
