import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

/** То, что лежит в `value` кнопки Slack. Коротко, чтобы уложиться в лимит Slack. */
const SlackChoiceValueSchema = z.object({
  a: id,
  p: id,
  i: z.number().int().min(0).max(5),
});

export function encodeSlackChoice(choice: { agentId: string; approvalId: string; index: number }): string {
  return JSON.stringify({ a: choice.agentId, p: choice.approvalId, i: choice.index });
}

export function decodeSlackChoice(value: string): { agentId: string; approvalId: string; index: number } | null {
  try {
    const parsed = SlackChoiceValueSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    return { agentId: parsed.data.a, approvalId: parsed.data.p, index: parsed.data.i };
  } catch {
    return null;
  }
}
