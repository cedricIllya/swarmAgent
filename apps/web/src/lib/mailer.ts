import type { OutboundEmail } from "@swarm/contracts";
import { sendViaMailgun } from "@swarm/mail";
import type { AgentRow } from "@swarm/agents";
import { env } from "@/env";

/** Письмо от имени агента с его адреса. Ключ Mailgun живёт только здесь. */
export async function sendAsAgent(agent: AgentRow, mail: OutboundEmail): Promise<{ messageId: string }> {
  const apiKey = env.mailgun.apiKey;
  if (!apiKey) throw new Error("MAILGUN_API_KEY не задан");
  return sendViaMailgun(
    { apiKey, region: env.mailgun.region, domain: agent.domain },
    `${agent.name} <${agent.localPart}@${agent.domain}>`,
    mail,
  );
}
