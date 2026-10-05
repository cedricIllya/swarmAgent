/** Имя кадра сессии. Всё остальное в путь файла не попадает. */
export function shotFile(name: string): string | null {
  return /^\d{1,3}\.jpg$/.test(name) ? name : null;
}
