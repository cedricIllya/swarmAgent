"use client";

import { useEffect, useRef, useState } from "react";
import { mergeAccess, type AgentAccess, type LiveAccess } from "./agent-access";

export function useAgentAccess(
  agentId: string,
  live: LiveAccess[],
): { accesses: AgentAccess[]; ready: boolean; forget: (slug: string) => void } {
  const [saved, setSaved] = useState<AgentAccess[]>([]);
  const [ready, setReady] = useState(false);
  const [forgotten, setForgotten] = useState<string[]>([]);
  const req = useRef(0);

  useEffect(() => {
    setForgotten([]);
    setSaved([]);
    setReady(false);
  }, [agentId]);

  useEffect(() => {
    const id = ++req.current;
    void fetch(`/api/agents/${agentId}/credentials`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || id !== req.current) return;
        const rows = (await res.json()) as AgentAccess[];
        setSaved(rows);
        setForgotten((prev) => prev.filter((slug) => !rows.some((row) => row.slug === slug)));
      })
      .finally(() => {
        if (id === req.current) setReady(true);
      });
  }, [agentId, live.length]);

  function forget(slug: string) {
    req.current += 1;
    setForgotten((prev) => (prev.includes(slug) ? prev : [...prev, slug]));
    setSaved((rows) => rows.filter((row) => row.slug !== slug));
  }

  const accesses = mergeAccess(live, saved).filter((item) => !forgotten.includes(item.slug));
  return { accesses, ready, forget };
}
