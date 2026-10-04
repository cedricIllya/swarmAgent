import { getAgentById, runtimeTokenOf, type AgentRow } from "@swarm/agents";
import { safeEqual } from "@swarm/crypto";
import { db } from "./db";

/**
 * Запросы runtime → control plane: `Authorization: Bearer <RUNTIME_TOKEN>`
 * и `X-Agent-Id`. Токен сравнивается с расшифрованным из базы.
 */
export async function authenticateRuntime(req: Request): Promise<AgentRow | null> {
  const agentId = req.headers.get("x-agent-id");
  const header = req.headers.get("authorization") ?? "";
  if (!agentId || !header.startsWith("Bearer ")) return null;
  const agent = await getAgentById(db(), agentId);
  if (!agent?.runtimeTokenEnc) return null;
  return safeEqual(runtimeTokenOf(agent), header.slice(7)) ? agent : null;
}
