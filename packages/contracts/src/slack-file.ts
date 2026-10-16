import { z } from "zod";

/** Файл на сообщении Slack. Ссылку скачивания сюда не кладём: её берёт runtime по id. */
export const SlackFileRefSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(180),
  mimetype: z.string().max(128),
  size: z.number().int().nonnegative().max(50_000_000),
  preview: z.string().max(1500).optional(),
});

export type SlackFileRef = z.infer<typeof SlackFileRefSchema>;

const MAX_FILES = 8;

/** id, имя, тип и короткий текст из объекта файла Slack. Чужие поля отбрасывает. */
export function slackFileRefs(raw: unknown): SlackFileRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SlackFileRef[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const id = item.trim();
      if (!id || id.length > 32) continue;
      out.push({ id, name: "файл", mimetype: "", size: 0 });
    } else if (item && typeof item === "object") {
      const file = item as Record<string, unknown>;
      if (typeof file.id !== "string" || !file.id || file.id.length > 32) continue;
      const named = typeof file.name === "string" && file.name.trim() ? file.name : typeof file.title === "string" ? file.title : "";
      const name = named.replace(/\s+/g, " ").trim().slice(0, 180) || "файл";
      const mimetype = typeof file.mimetype === "string" ? file.mimetype.trim().slice(0, 128) : "";
      const sizeNum = typeof file.size === "number" && Number.isFinite(file.size) ? Math.floor(file.size) : 0;
      const size = sizeNum > 0 && sizeNum <= 50_000_000 ? sizeNum : 0;
      const previewRaw = typeof file.preview === "string" ? file.preview.trim() : "";
      const preview = previewRaw.slice(0, 1500);
      out.push({ id: file.id, name, mimetype, size, ...(preview ? { preview } : {}) });
    }
    if (out.length >= MAX_FILES) break;
  }
  return out;
}
