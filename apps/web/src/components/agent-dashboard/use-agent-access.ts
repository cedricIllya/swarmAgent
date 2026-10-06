"use client";

import { useEffect, useState } from "react";
import { mergeAccess, type AgentAccess, type LiveAccess } from "./agent-access";

export function useAgentAccess(agentId: string, live: LiveAccess[]): { accesses: AgentAccess[]; ready: boolean } {
  const [saved, setSaved] = useState<AgentAccess[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancel = false;
    void fetch(`/api/agents/${agentId}/credentials`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || cancel) return;
        setSaved((await res.json()) as AgentAccess[]);
      })
      .finally(() => {
        if (!cancel) setReady(true);
      });
    return () => {
      cancel = true;
    };
  }, [agentId, live.length]);

  return { accesses: mergeAccess(live, saved), ready };
}
