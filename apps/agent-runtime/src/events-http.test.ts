import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RuntimeState } from "@swarm/contracts";
import { emitRuntime } from "./events";
import { streamRuntimeEvents } from "./events-http";

const state = { agentId: "agt" } as RuntimeState;

describe("GET /events", () => {
  it("sends a snapshot and then a step", async () => {
    const app = new Hono();
    app.get("/events", (c) => streamRuntimeEvents(c, { state: async () => state }));
    const res = await app.request("/events");
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("нет тела");
    const dec = new TextDecoder();
    let buf = "";
    let sent = false;
    const deadline = Date.now() + 3_000;
    while (!buf.includes("event: step") && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value);
      if (buf.includes("event: snapshot") && !sent) {
        sent = true;
        setTimeout(() => {
          emitRuntime({
            type: "step",
            runId: "run_1",
            step: { at: "t", kind: "note", text: "вошёл" },
          });
        }, 30);
      }
    }
    await reader.cancel();
    expect(buf).toContain("event: snapshot");
    expect(buf).toContain("вошёл");
    expect(buf).toContain("event: step");
  });
});
