import { EventEmitter } from "node:events";
import type { RuntimeEvent } from "@swarm/contracts";

const bus = new EventEmitter();
bus.setMaxListeners(100);

const streams = new Set<AbortController>();

export function emitRuntime(event: RuntimeEvent): void {
  bus.emit("event", event);
}

export function onRuntime(listener: (event: RuntimeEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

/** Открытый SSE. Перед сном все закрываются, чтобы прокси не висел на замороженной машине. */
export function trackStream(controller: AbortController): () => void {
  streams.add(controller);
  return () => streams.delete(controller);
}

/**
 * Сначала событие `sleeping`, затем обрыв потоков.
 * Пауза даёт записать событие в сокет до abort.
 */
export function closeAllStreams(): void {
  emitRuntime({ type: "sleeping" });
  setTimeout(() => {
    for (const controller of streams) controller.abort();
    streams.clear();
  }, 30);
}
