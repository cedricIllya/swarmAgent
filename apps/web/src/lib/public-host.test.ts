import { describe, expect, it } from "vitest";
import { publicHostAllowed } from "./public-host";

const appUrl = "https://swarm.cedricillya.online";

describe("publicHostAllowed", () => {
  it("allows the custom domain and local development", () => {
    expect(publicHostAllowed("swarm.cedricillya.online", appUrl)).toBe(true);
    expect(publicHostAllowed("localhost:3000", appUrl)).toBe(true);
    expect(publicHostAllowed("127.0.0.1:3000", appUrl)).toBe(true);
  });

  it("rejects the fly.dev hostname and a bare IP", () => {
    expect(publicHostAllowed("swarm-control-plane.fly.dev", appUrl)).toBe(false);
    expect(publicHostAllowed("66.241.124.32", appUrl)).toBe(false);
    expect(publicHostAllowed(null, appUrl)).toBe(false);
  });
});
