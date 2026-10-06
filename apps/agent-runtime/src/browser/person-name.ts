export interface PersonName {
  first: string;
  last: string;
  full: string;
}

/** Имя и фамилия агента. Если их не задали при создании, режем отображаемое имя по первому пробелу. */
export function personName(agentName: string, firstName?: string | null, lastName?: string | null): PersonName {
  const first = firstName?.trim() ?? "";
  const last = lastName?.trim() ?? "";
  if (first && last) return { first, last, full: `${first} ${last}` };
  const parts = agentName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { first: parts[0]!, last: parts.slice(1).join(" "), full: parts.join(" ") };
  const only = parts[0] || first || "Agent";
  return { first: only, last: only, full: only };
}

/** Как заполнять имя в форме сервиса: first name и last name отдельно. */
export function registrationNameLine(agentName: string, firstName?: string | null, lastName?: string | null): string {
  const person = personName(agentName, firstName, lastName);
  const fields =
    person.first === person.last
      ? `first name и last name — «${person.first}» (одно слово в оба поля)`
      : `first name — «${person.first}», last name — «${person.last}»`;
  return `Имя вводи сам, до отправки: ${fields}; full name, display name и username — «${person.full}». Пустым имя не оставляй.`;
}
