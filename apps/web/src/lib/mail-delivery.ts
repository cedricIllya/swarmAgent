import type { InboundEmail } from "@swarm/contracts";
import { getAgentById } from "@swarm/agents";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";
import { inboundMail } from "@/lib/undelivered-mail";

/**
 * Пробуждение по письму. 45 с не хватает, когда машина как раз засыпает:
 * Fly отвечает «machine still active, refusing to start», пока suspend не закончится,
 * и до started проходит больше минуты. Короткий обрыв запроса ещё и срывает подъём.
 */
export const EMAIL_WAKE_MS = 180_000;

/** `true` — runtime письмо принял. */
export async function deliverInbound(agentId: string, email: InboundEmail): Promise<boolean> {
  const agent = await getAgentById(db(), agentId);
  if (!agent || agent.status !== "running") {
    console.warn(`[mail] агент ${agentId} не запущен (${agent?.status ?? "нет"}); письмо «${email.subject}» подождёт`);
    return false;
  }
  try {
    const client = await awakeRuntime(agent, EMAIL_WAKE_MS);
    if (!client) return false;
    await client.deliverEmail({ email });
    console.log(`[mail] письмо доставлено ${agentId}: ${email.subject}`);
    return true;
  } catch (e) {
    console.warn(`[mail] ${agentId} «${email.subject}»: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Одна попытка сразу. Не вышло — письмо остаётся и уходит со следующим проходом часов. */
export async function acceptInbound(agentId: string, email: InboundEmail): Promise<void> {
  if (await deliverInbound(agentId, email)) return;
  inboundMail.enqueue({ agentId, email, enqueuedAt: Date.now() });
  console.warn(`[mail] письмо ${agentId} «${email.subject}» отложено, повторю`);
}

export async function retryInboundMail(): Promise<void> {
  if (inboundMail.size() === 0) return;
  try {
    const r = await inboundMail.drain((agentId, email) => deliverInbound(agentId, email));
    if (r.delivered || r.dropped || r.left) {
      console.log(`[mail] доставлено ${r.delivered}, сброшено ${r.dropped}, ждут ${r.left}`);
    }
  } catch (e) {
    console.warn(`[mail] повтор не вышел: ${e instanceof Error ? e.message : String(e)}`);
  }
}
