import { dateKey, formatSheetDate, isLastDayOfMonth, monthKey, zonedStartOfDay, zonedStartOfMonth, zonedStartOfNextDay } from "@/lib/domain/time";

const TZ = "Asia/Dushanbe"; // UTC+5

describe("часовой пояс Asia/Dushanbe", () => {
  it("локальная дата определяется по поясу, а не по UTC", () => {
    expect(dateKey(new Date("2026-10-20T20:30:00Z"), TZ)).toBe("2026-10-21"); // 01:30 следующего дня
    expect(dateKey(new Date("2026-10-20T18:59:00Z"), TZ)).toBe("2026-10-20");
    expect(monthKey(new Date("2026-10-31T20:00:00Z"), TZ)).toBe("2026-11");
  });

  it("границы суток и месяца в UTC", () => {
    const d = new Date("2026-10-20T12:00:00Z");
    expect(zonedStartOfDay(d, TZ).toISOString()).toBe("2026-10-19T19:00:00.000Z");
    expect(zonedStartOfNextDay(d, TZ).toISOString()).toBe("2026-10-20T19:00:00.000Z");
    expect(zonedStartOfMonth(d, TZ).toISOString()).toBe("2026-09-30T19:00:00.000Z");
  });

  it("последний день месяца (в т.ч. 29 февраля високосного года)", () => {
    expect(isLastDayOfMonth(new Date("2026-10-31T12:00:00Z"), TZ)).toBe(true);
    expect(isLastDayOfMonth(new Date("2026-10-30T12:00:00Z"), TZ)).toBe(false);
    expect(isLastDayOfMonth(new Date("2028-02-29T12:00:00Z"), TZ)).toBe(true);
    expect(isLastDayOfMonth(new Date("2028-02-28T12:00:00Z"), TZ)).toBe(false);
  });

  it("корректно работает и в поясе с переходом на летнее время (23-часовые сутки)", () => {
    const berlin = "Europe/Berlin";
    const d = new Date("2026-03-29T12:00:00Z");
    expect(zonedStartOfDay(d, berlin).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(zonedStartOfNextDay(d, berlin).toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("форматы даты для таблицы", () => {
    const d = new Date("2026-10-20T12:00:00Z");
    expect(formatSheetDate(d, TZ, "dd.MM.yyyy")).toBe("20.10.2026");
    expect(formatSheetDate(d, TZ, "yyyy-MM-dd")).toBe("2026-10-20");
    expect(formatSheetDate(d, TZ, "MM/dd/yyyy")).toBe("10/20/2026");
  });
});
