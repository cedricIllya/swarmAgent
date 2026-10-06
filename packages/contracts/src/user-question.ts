/**
 * Вопрос модели к владельцу с нумерованными вариантами.
 * Ловит и список с новой строки, и «1. … 2. …» в одном абзаце.
 */
export interface UserQuestion {
  prompt: string;
  options: string[];
}

interface Mark {
  num: number;
  index: number;
  end: number;
}

const FENCE = /```[\s\S]*?```/g;
const OPTION_MARK = /(?:^|[\s:;—–-])(\d{1,2})[.)]\s+/g;
const TRAILING_QUESTION =
  /^(.*\S)\s+((?:На каком|Какой|Какая|Какие|Какое|Каким|Что|Где|Куда|Когда|Как|Кто|Нужно ли|Можно ли)\b[^?\n]{0,180}\?)\s*$/i;

export function parseUserQuestion(text: string): UserQuestion | null {
  const raw = text.replace(/\r\n/g, "\n").replace(FENCE, " ").trim();
  if (!raw || raw.length > 8000 || !raw.includes("?")) return null;

  const seq = bestSequence(marksIn(raw));
  if (!seq) return null;

  const before = raw.slice(0, seq[0]!.index).trim();
  const options: string[] = [];
  let tail = "";
  for (let i = 0; i < seq.length; i++) {
    const start = seq[i]!.end;
    const end = i + 1 < seq.length ? seq[i + 1]!.index : raw.length;
    let body = raw.slice(start, end).replace(/\s+/g, " ").trim();
    if (i === seq.length - 1) {
      const peeled = peelTrailingQuestion(body);
      body = peeled.option;
      tail = peeled.tail;
    }
    if (body.length < 2 || body.length > 400) return null;
    options.push(body);
  }

  const prompt = [before, tail].filter(Boolean).join("\n").trim() || "Выберите вариант или напишите ответ.";
  return { prompt, options };
}

function marksIn(raw: string): Mark[] {
  const marks: Mark[] = [];
  const re = new RegExp(OPTION_MARK.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const num = Number(m[1]);
    if (!num) continue;
    marks.push({ num, index: m.index, end: m.index + m[0].length });
  }
  return marks;
}

/** Последний список 1. 2. … не длиннее шести пунктов. */
function bestSequence(marks: Mark[]): Mark[] | null {
  let best: Mark[] | null = null;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i]!.num !== 1) continue;
    const seq = [marks[i]!];
    for (let j = i + 1; j < marks.length && seq.length < 6; j++) {
      if (marks[j]!.num !== seq.length + 1) break;
      seq.push(marks[j]!);
    }
    if (seq.length >= 2) best = seq;
  }
  return best;
}

function peelTrailingQuestion(body: string): { option: string; tail: string } {
  const addressed = body.match(TRAILING_QUESTION);
  if (addressed?.[1] && addressed[2] && addressed[1].length >= 2) {
    return { option: addressed[1].trim(), tail: addressed[2].trim() };
  }
  const sentence = body.match(/^(.*\S)\s+([A-ZА-ЯЁ][^?\n]{0,180}\?)\s*$/);
  if (sentence?.[1] && sentence[2] && sentence[1].length >= 8) {
    return { option: sentence[1].trim(), tail: sentence[2].trim() };
  }
  return { option: body.trim(), tail: "" };
}
