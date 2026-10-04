import { describe, expect, it } from "vitest";
import { matchRecipe, pickServiceDomain, rootDomain, sameBrand, slugFor } from "./domains";

describe("sameBrand", () => {
  it("joins a brand across TLDs but not generic labels", () => {
    expect(sameBrand("notion.so", "mcp.notion.com")).toBe(true);
    expect(sameBrand("app.linear.app", "linear.app")).toBe(true);
    expect(sameBrand("mail.ru", "mail.com")).toBe(false);
    expect(sameBrand("x.com", "x.io")).toBe(false);
    expect(sameBrand("linear.app", "notion.so")).toBe(false);
  });
});

describe("rootDomain", () => {
  it("collapses subdomains to the registrable root", () => {
    expect(rootDomain("mail.linear.app")).toBe("linear.app");
    expect(rootDomain("www.notion.so")).toBe("notion.so");
    expect(rootDomain("app.example.co.uk")).toBe("example.co.uk");
    expect(rootDomain("localhost")).toBe("localhost");
  });
});

describe("pickServiceDomain", () => {
  it("prefers the classifier hint over links", () => {
    expect(pickServiceDomain("linear.app", ["https://sendgrid.net/track/1"])).toBe("linear.app");
  });

  it("skips mail tracking hosts and votes among the rest", () => {
    const links = [
      "https://click.sendgrid.net/x",
      "https://u123.list-manage.com/y",
      "https://app.acme.io/invite/abc",
      "https://acme.io/terms",
      "https://twitter.com/acme",
    ];
    expect(pickServiceDomain(null, links)).toBe("acme.io");
  });

  it("returns null when nothing usable is left", () => {
    expect(pickServiceDomain(null, ["https://mailgun.org/u/1"])).toBeNull();
  });
});

describe("matchRecipe / slugFor", () => {
  it("matches hosts to recipe domains including subdomains", () => {
    const recipes = [{ slug: "linear", name: "Linear", kind: "mcp" as const, domains: ["linear.app"], notes: "", discoveredBy: null }];
    expect(matchRecipe(recipes, ["mail.linear.app"])?.slug).toBe("linear");
    expect(matchRecipe(recipes, ["notion.so"])).toBeNull();
  });

  it("derives a slug from the domain or the service name", () => {
    expect(slugFor("linear.app", null)).toBe("linear");
    expect(slugFor(null, "Яндекс Трекер")).toBe("service");
    expect(slugFor(null, "Acme Cloud")).toBe("acme-cloud");
  });
});
