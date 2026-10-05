import { describe, expect, it } from "vitest";
import { originsFromRequest } from "./origins";

function request(headers: Record<string, string>): Request {
  return new Request("https://swarm-control-plane.fly.dev/api/auth/delete-user", { headers });
}

describe("originsFromRequest", () => {
  it("trusts the browser origin when it matches the Host header", () => {
    const origins = originsFromRequest(
      request({
        origin: "https://swarm-control-plane.fly.dev",
        host: "swarm-control-plane.fly.dev",
      }),
    );
    expect(origins).toEqual(["https://swarm-control-plane.fly.dev"]);
  });

  it("does not trust a cross-site Origin", () => {
    expect(
      originsFromRequest(
        request({
          origin: "https://evil.example",
          host: "swarm-control-plane.fly.dev",
        }),
      ),
    ).toEqual([]);
  });

  it("keeps an explicit extra origin without a request", () => {
    expect(originsFromRequest(undefined, ["https://swarm-control-plane.fly.dev/"])).toEqual([
      "https://swarm-control-plane.fly.dev",
    ]);
  });

  it("ignores a missing or null origin", () => {
    expect(originsFromRequest(request({ host: "swarm-control-plane.fly.dev" }))).toEqual([]);
    expect(
      originsFromRequest(request({ origin: "null", host: "swarm-control-plane.fly.dev" })),
    ).toEqual([]);
  });
});
