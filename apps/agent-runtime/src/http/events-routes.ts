import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RuntimeState } from "@swarm/contracts";
import { onRuntime, trackStream } from "../core/events";

/**
 * `GET /events`: снимок, затем события шины. Не отмечает активность —
 * открытая карточка не должна держать машину бодрствующей.
 */
export function streamRuntimeEvents(c: Context, rt: { state: () => Promise<RuntimeState> }): Response {
  return streamSSE(c, async (stream) => {
    const state = await rt.state();
    await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ type: "snapshot", state }) });

    let heartbeat: NodeJS.Timeout | undefined;
    let off = () => {};
    let finished = false;

    await new Promise<void>((resolve) => {
      const finish = () => {
        if (finished) return;
        finished = true;
        off();
        if (heartbeat) clearInterval(heartbeat);
        untrack();
        resolve();
      };
      const controller = new AbortController();
      const untrack = trackStream(controller);
      controller.signal.addEventListener("abort", finish);
      stream.onAbort(finish);
      off = onRuntime((event) => {
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => finish());
      });
      heartbeat = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "{}" }).catch(() => undefined);
      }, 15_000);
    });
  });
}
