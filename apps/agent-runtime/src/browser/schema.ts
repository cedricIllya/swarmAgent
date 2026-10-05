import { z, type ZodType } from "zod";

/**
 * Stagehand 4 принимает в `extract` только Zod-схему: объект без `parse`/`safeParse` он считает
 * опциями и отвергает ключи `type`, `properties`, `required`. Цикл приглашения и Hermes
 * через `/browser/extract` описывают ответ JSON Schema — переводим её в Zod.
 */
export function toExtractSchema(schema: unknown): ZodType | undefined {
  if (schema === undefined || schema === null) return undefined;
  if (isZodSchema(schema)) return schema;
  if (typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("схема extract должна быть объектом JSON Schema");
  }
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (e) {
    throw new Error(`схема extract не разобрана: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isZodSchema(value: unknown): value is ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { parse?: unknown }).parse === "function" &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}
