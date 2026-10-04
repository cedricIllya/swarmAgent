import { describe, expect, it } from "vitest";
import { htmlToText, normalizeJson, normalizeMailgunForm, stripQuotedReply } from "./normalize";

describe("normalizeMailgunForm", () => {
  it("maps fields, headers, verdicts, dkim and reply text", () => {
    const email = normalizeMailgunForm({
      recipient: "vladimir.lenin+g@agents.test",
      sender: "bounce@mail.linear.app",
      from: "Linear <notifications@linear.app>",
      subject: "You were invited",
      "body-plain": "Join here\n\n> old quote",
      "body-html": '<p>Join <a href="https://linear.app/join/abc">here</a></p><script>x()</script>',
      "message-headers": JSON.stringify([
        ["Message-Id", "<abc@linear.app>"],
        ["In-Reply-To", "<prev@agents.test>"],
        ["References", "<a@x> <b@x>"],
        ["DKIM-Signature", "v=1; a=rsa-sha256; d=linear.app; s=sel"],
        ["DKIM-Signature", "v=1; d=mail.linear.app"],
        ["X-Mailgun-Spf", "Pass"],
        ["X-Mailgun-Dkim-Check-Result", "Pass"],
      ]),
    });
    expect(email.to).toBe("vladimir.lenin+g@agents.test");
    expect(email.sender).toBe("bounce@mail.linear.app");
    expect(email.from).toContain("linear.app");
    expect(email.messageId).toBe("<abc@linear.app>");
    expect(email.inReplyTo).toBe("<prev@agents.test>");
    expect(email.references).toEqual(["<a@x>", "<b@x>"]);
    expect(email.dkimDomains).toEqual(["linear.app", "mail.linear.app"]);
    expect(email.spf).toBe("pass");
    expect(email.dkim).toBe("pass");
    expect(email.links).toEqual(["https://linear.app/join/abc"]);
    expect(email.replyText).toBe("Join here");
    expect(email.headers["message-id"]).toBe("<abc@linear.app>");
  });

  it("caps references at 20", () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<r${i}@x>`).join(" ");
    const email = normalizeMailgunForm({
      recipient: "a@b.c",
      from: "x@y.z",
      subject: "",
      "body-plain": "",
      "message-headers": JSON.stringify([["References", refs]]),
    });
    expect(email.references).toHaveLength(20);
    expect(email.references[0]).toBe("<r10@x>");
  });
});

describe("normalizeJson", () => {
  it("maps postmark shape", () => {
    const email = normalizeJson({
      From: "boss@corp.com",
      OriginalRecipient: "ops@agents.test",
      Subject: "Hi",
      TextBody: "do the thing\n\nOn Mon, x wrote:\n> old",
      HtmlBody: "",
      StrippedTextReply: "do the thing",
      MessageID: "pm-123",
      Headers: [{ Name: "X-Custom", Value: "1" }],
    });
    expect(email.to).toBe("ops@agents.test");
    expect(email.messageId).toBe("<pm-123>");
    expect(email.headers["x-custom"]).toBe("1");
    expect(email.replyText).toBe("do the thing");
  });
});

describe("htmlToText", () => {
  it("drops scripts and collects links", () => {
    const r = htmlToText('<div>Hello<br>World</div><script>alert(1)</script><a href="https://a.b/c?x=1&amp;y=2">x</a>');
    expect(r.text).toBe("Hello\nWorld\nx");
    expect(r.links).toEqual(["https://a.b/c?x=1&y=2"]);
  });
});

describe("stripQuotedReply", () => {
  it("cuts at quote markers", () => {
    expect(stripQuotedReply("yes\n\nOn Tue, Bob wrote:\n> q")).toBe("yes");
    expect(stripQuotedReply("да\n\n> q")).toBe("да");
  });
});
