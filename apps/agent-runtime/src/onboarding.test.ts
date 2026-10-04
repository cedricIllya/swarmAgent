import { describe, expect, it } from "vitest";
import { pickInviteLink } from "./onboarding";

describe("pickInviteLink", () => {
  it("prefers an invite-looking link on the service domain", () => {
    const links = [
      "https://u1.sendgrid.net/track/abc",
      "https://acme.io/privacy",
      "https://app.acme.io/invite/xyz",
      "https://acme.io/blog/new",
    ];
    expect(pickInviteLink(links, "acme.io")).toBe("https://app.acme.io/invite/xyz");
  });

  it("falls back to any non-noise link when the domain is unknown", () => {
    expect(pickInviteLink(["https://u1.sendgrid.net/x", "https://acme.io/join/abc"], null)).toBe("https://acme.io/join/abc");
    expect(pickInviteLink(["https://mailgun.org/u/1"], "acme.io")).toBeNull();
  });
});
