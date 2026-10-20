// Работа с часовым поясом без внешних библиотек (по умолчанию Asia/Dushanbe, UTC+5, без DST).
// Всё посчитано через Intl, поэтому работает и для поясов с переходом на летнее время.

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function zonedParts(date: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const get = (type: string) => Number(fmt.formatToParts(date).find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Смещение пояса от UTC в миллисекундах на момент date. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

export function zonedStartOfDay(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  const localMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  const first = localMidnightAsUtc - tzOffsetMs(new Date(localMidnightAsUtc), tz);
  // второй проход учитывает случай, когда смещение в полночь отличается от смещения «сейчас» (DST)
  return new Date(localMidnightAsUtc - tzOffsetMs(new Date(first), tz));
}

export function zonedStartOfNextDay(date: Date, tz: string): Date {
  return zonedStartOfDay(new Date(zonedStartOfDay(date, tz).getTime() + 30 * 3_600_000), tz);
}

export function zonedStartOfMonth(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  const localAsUtc = Date.UTC(p.year, p.month - 1, 1);
  const first = localAsUtc - tzOffsetMs(new Date(localAsUtc), tz);
  return new Date(localAsUtc - tzOffsetMs(new Date(first), tz));
}

const two = (n: number) => String(n).padStart(2, "0");

export function dateKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

export function monthKey(date: Date, tz: string): string {
  return dateKey(date, tz).slice(0, 7);
}

export function isLastDayOfMonth(date: Date, tz: string): boolean {
  return monthKey(zonedStartOfNextDay(date, tz), tz) !== monthKey(date, tz);
}

export type SheetDateFormat = "dd.MM.yyyy" | "yyyy-MM-dd" | "MM/dd/yyyy";

export function formatSheetDate(date: Date, tz: string, format: SheetDateFormat): string {
  const p = zonedParts(date, tz);
  const [dd, mm, yyyy] = [two(p.day), two(p.month), String(p.year)];
  if (format === "yyyy-MM-dd") return `${yyyy}-${mm}-${dd}`;
  if (format === "MM/dd/yyyy") return `${mm}/${dd}/${yyyy}`;
  return `${dd}.${mm}.${yyyy}`;
}

export function formatDateTimeRu(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${two(p.day)}.${two(p.month)}.${p.year} ${two(p.hour)}:${two(p.minute)}`;
}
