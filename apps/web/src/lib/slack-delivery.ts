import type { DeliverSlackEventRequest } from "@swarm/contracts";
import { getAgentById, rememberTickQuiet } from "@swarm/agents";
import { deleteCredential, findSlackInstall } from "@swarm/connections";
import { db } from "@/lib/db";
import { pushServicesToAgent } from "@/lib/create-agent";
import { awakeRuntime } from "@/lib/runtime-client";
import { slackMrkdwn, type SlackChoiceNotice } from "@/lib/slack";

/** Как у почты: машина может засыпать дольше минуты, пока Fly не отдаст порт. */
const SLACK_WAKE_MS = 180_000;
const RETRY_TTL_MS = 30 * 60 * 1000;

interface PendingSlack {
  agentId: string;
  event: DeliverSlackEventRequest;
  enqueuedAt: number;
}

function createQueue() {
  const pending: PendingSlack[] = [];
  let draining = false;
  return {
    size: (): number => pending.length,
    enqueue(item: PendingSlack): void {
      if (pending.some((row) => row.agentId === item.agentId && row.event.eventId === item.event.eventId)) return;
      pending.push(item);
    },
    async drain(deliver: (item: PendingSlack) => Promise<boolean>, now = Date.now()): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        const batch = pending.splice(0, pending.length);
        const again: PendingSlack[] = [];
        for (const item of batch) {
          if (now - item.enqueuedAt > RETRY_TTL_MS) {
            console.error(`[slack] событие ${item.event.eventId} для ${item.agentId} не доставлено за 30 мин`);
            continue;
          }
          const ok = await deliver(item).catch(() => false);
          if (!ok) again.push(item);
        }
        pending.unshift(...again);
      } finally {
        draining = false;
      }
    },
  };
}

const queue = createQueue();

interface PendingChoice extends SlackChoiceNotice {
  enqueuedAt: number;
}

function createChoiceQueue() {
  const pending: PendingChoice[] = [];
  let draining = false;
  return {
    size: (): number => pending.length,
    enqueue(item: PendingChoice): void {
      const prev = pending.find((row) => row.agentId === item.agentId && row.approvalId === item.approvalId);
      if (prev) {
        if (item.responseUrl) prev.responseUrl = item.responseUrl;
        return;
      }
      pending.push(item);
    },
    async drain(deliver: (item: PendingChoice) => Promise<boolean>, now = Date.now()): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        const batch = pending.splice(0, pending.length);
        const again: PendingChoice[] = [];
        for (const item of batch) {
          if (now - item.enqueuedAt > RETRY_TTL_MS) {
            console.error(`[slack] выбор ${item.approvalId} для ${item.agentId} не доставлен за 30 мин`);
            continue;
          }
          const ok = await deliver(item).catch(() => false);
          if (!ok) again.push(item);
        }
        pending.unshift(...again);
      } finally {
        draining = false;
      }
    },
  };
}

const choices = createChoiceQueue();

async function replaceSlackMessage(responseUrl: string, text: string): Promise<void> {
  if (!responseUrl) return;
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ replace_original: true, text: slackMrkdwn(text).slice(0, 3000) }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) console.warn(`[slack] не обновил сообщение с кнопками: ${res.status}`);
}

/** `true` — вопрос закрыт или его уже нет. `false` — машина не ответила, выбрать ещё раз. */
async function deliverSlackChoice(item: PendingChoice): Promise<boolean> {
  const agent = await getAgentById(db(), item.agentId);
  await rememberTickQuiet(db(), item.agentId, null).catch(() => undefined);
  if (!agent || agent.status !== "running") {
    console.warn(`[slack] агент ${item.agentId} не запущен (${agent?.status ?? "нет"}); выбор ${item.approvalId} подождёт`);
    return false;
  }
  try {
    const client = await awakeRuntime(agent, SLACK_WAKE_MS);
    if (!client) return false;
    const result = await client.resolveApproval(item.approvalId, { optionIndex: item.index });
    const answer = result.answer?.trim() || item.label;
    const text = [item.prompt, answer].filter(Boolean).join("\n\n");
    await replaceSlackMessage(item.responseUrl, text).catch((e) => {
      console.warn(`[slack] кнопки ${item.approvalId}: ${e instanceof Error ? e.message : String(e)}`);
    });
    console.log(`[slack] выбор ${item.approvalId} → ${item.agentId}`);
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("→ 404") || message.includes("→ 400")) {
      await replaceSlackMessage(item.responseUrl, [item.prompt, item.label].filter(Boolean).join("\n\n")).catch(() => undefined);
      return true;
    }
    console.warn(`[slack] выбор ${item.agentId} ${item.approvalId}: ${message}`);
    return false;
  }
}

/** Нажатие кнопки. Машина спит — выбор остаётся и уходит со следующим проходом часов. */
export async function acceptSlackChoice(choice: SlackChoiceNotice): Promise<void> {
  const item: PendingChoice = { ...choice, enqueuedAt: Date.now() };
  if (await deliverSlackChoice(item)) return;
  choices.enqueue(item);
  console.warn(`[slack] выбор ${choice.approvalId} для ${choice.agentId} отложен`);
}

/** `true` — runtime событие принял, повторил или отбросил как чужое. */
export async function deliverSlack(agentId: string, event: DeliverSlackEventRequest): Promise<boolean> {
  const agent = await getAgentById(db(), agentId);
  await rememberTickQuiet(db(), agentId, null).catch(() => undefined);
  if (!agent || agent.status !== "running") {
    console.warn(`[slack] агент ${agentId} не запущен (${agent?.status ?? "нет"}); событие ${event.eventId} подождёт`);
    return false;
  }
  try {
    const client = await awakeRuntime(agent, SLACK_WAKE_MS);
    if (!client) return false;
    const result = await client.deliverSlack(event);
    if (result.status === "unavailable") return false;
    console.log(`[slack] ${event.eventId} → ${agentId}: ${result.status}`);
    return true;
  } catch (e) {
    console.warn(`[slack] ${agentId} ${event.eventId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Одна попытка сразу. Не вышло — событие остаётся и уходит со следующим проходом часов. */
export async function acceptSlack(agentId: string, event: DeliverSlackEventRequest): Promise<void> {
  if (await deliverSlack(agentId, event)) return;
  queue.enqueue({ agentId, event, enqueuedAt: Date.now() });
  console.warn(`[slack] событие ${event.eventId} для ${agentId} отложено`);
}

export async function retrySlack(): Promise<void> {
  if (queue.size() > 0) await queue.drain((item) => deliverSlack(item.agentId, item.event));
  if (choices.size() > 0) await choices.drain((item) => deliverSlackChoice(item));
}

/**
 * Кому отдать событие. Сначала пользователи из `authorizations` и упоминаний:
 * в одной команде так живут несколько агентов. Никого не нашли — старая установка,
 * где ключом ещё записан id команды.
 */
export async function slackRecipients(
  userIds: string[],
  teamId: string,
): Promise<Array<{ agentId: string; tenantId: string; slug: string }>> {
  const found: Array<{ agentId: string; tenantId: string; slug: string }> = [];
  const seen = new Set<string>();
  for (const id of userIds) {
    const install = await findSlackInstall(db(), id);
    if (!install || seen.has(install.agentId)) continue;
    seen.add(install.agentId);
    found.push(install);
  }
  if (found.length > 0) return found;
  const legacy = await findSlackInstall(db(), teamId);
  return legacy ? [legacy] : [];
}

async function dropSlackInstall(key: string): Promise<void> {
  const install = await findSlackInstall(db(), key);
  if (!install) return;
  await deleteCredential(db(), install.agentId, install.slug);
  const agent = await getAgentById(db(), install.agentId);
  if (!agent) return;
  try {
    await pushServicesToAgent(agent);
  } catch (e) {
    console.warn(`[slack] снимок после отключения ${key}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Пользователь отозвал токен — секрет этого агента больше не действителен. */
export async function disconnectSlackUser(userId: string): Promise<void> {
  await dropSlackInstall(userId);
}

/** Приложение сняли целиком. Попадает в установку, где ключом ещё служит id команды. */
export async function disconnectSlackTeam(teamId: string): Promise<void> {
  await dropSlackInstall(teamId);
}
