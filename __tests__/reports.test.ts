import { getDb } from "@/lib/mongodb";
import { resetIndexCacheForTests, type Lead } from "@/lib/db/collections";
import { claimLead, createLeadIfNew, markEscalated, markPublished } from "@/lib/db/leads";
import { aggregateReport, buildReport, renderReportEmail, renderReportTelegram, sendReport, type ReportDeps } from "@/lib/services/reports";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

const TZ = "Asia/Dushanbe";
let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  resetIndexCacheForTests();
});

const at = (iso: string) => new Date(iso);
let phoneSeq = 0;

async function seed(opts: { created: string; source?: string; name?: string; published?: string; claimedAt?: string; manager?: [number, string, "Менеджер 1" | "Менеджер 2"]; escalated?: string }): Promise<Lead> {
  const phone = `99293${String(1000000 + phoneSeq++)}`;
  let { lead } = await createLeadIfNew({ name: opts.name ?? "Клиент", phone, source: (opts.source ?? "WhatsApp") as never, channel: "whatsapp" }, at(opts.created));
  if (opts.published) await markPublished(lead._id, { chatId: 1, messageId: 1 }, at(opts.published));
  if (opts.escalated) await markEscalated(lead._id, at(opts.escalated));
  if (opts.manager && opts.claimedAt) {
    const [id, name, sheet] = opts.manager;
    await claimLead(lead._id.toHexString(), { telegramId: id, name, sheetName: sheet }, at(opts.claimedAt));
  }
  const stored = db.collection("leads").docs.find((d) => d._id.equals(lead._id)) as Lead;
  return stored;
}

describe("aggregateReport", () => {
  const meta = { kind: "daily" as const, label: "20.10.2026", period: "2026-10-20", from: at("2026-10-19T19:00:00Z"), to: at("2026-10-20T19:00:00Z") };

  it("считает лиды, захваты, ожидающих, эскалации и среднее время до захвата", async () => {
    const leads = [
      await seed({ created: "2026-10-20T05:00:00Z", source: "Таргет Instagram", published: "2026-10-20T05:00:00Z", claimedAt: "2026-10-20T05:02:00Z", manager: [1, "Алиса", "Менеджер 1"] }),
      await seed({ created: "2026-10-20T06:00:00Z", source: "Таргет Instagram", published: "2026-10-20T06:00:00Z", claimedAt: "2026-10-20T06:06:00Z", manager: [2, "Бобо", "Менеджер 2"], escalated: "2026-10-20T06:05:00Z" }),
      await seed({ created: "2026-10-20T07:00:00Z", source: "WhatsApp", published: "2026-10-20T07:00:00Z" }),
      await seed({ created: "2026-10-20T08:00:00Z", source: "Звонок входящий", claimedAt: "2026-10-20T08:00:00Z", manager: [1, "Алиса", "Менеджер 1"] }), // ручной: публикации нет
    ];
    const r = aggregateReport(leads, meta);

    expect(r).toMatchObject({ total: 4, claimed: 3, pending: 1, escalated: 1, sheetFailed: 0 });
    expect(r.avgClaimMinutes).toBeCloseTo(4, 5); // (2 + 6) / 2 — ручной лид в скорость не входит
    expect(r.byManager.map((m) => [m.name, m.claimed, m.avgClaimMinutes])).toEqual([["Алиса", 2, 2], ["Бобо", 1, 6]]);
    expect(r.bySource).toEqual([
      { source: "Таргет Instagram", total: 2, claimed: 2 },
      { source: "WhatsApp", total: 1, claimed: 0 },
      { source: "Звонок входящий", total: 1, claimed: 1 },
    ]);
  });

  it("пустой период", () => {
    const r = aggregateReport([], meta);
    expect(r).toMatchObject({ total: 0, claimed: 0, avgClaimMinutes: null, byManager: [], bySource: [] });
  });
});

describe("buildReport — границы периода в часовом поясе Asia/Dushanbe", () => {
  it("дневной отчёт берёт лиды локальных суток, а не UTC", async () => {
    await seed({ created: "2026-10-19T18:30:00Z" }); // 23:30 19 октября — вчера
    await seed({ created: "2026-10-19T19:30:00Z" }); // 00:30 20 октября — сегодня
    await seed({ created: "2026-10-20T18:30:00Z" }); // 23:30 20 октября — сегодня
    await seed({ created: "2026-10-20T19:30:00Z" }); // 00:30 21 октября — завтра
    const r = await buildReport("daily", at("2026-10-20T12:00:00Z"), TZ);
    expect(r).toMatchObject({ total: 2, label: "20.10.2026", period: "2026-10-20" });
  });

  it("месячный отчёт — с начала месяца по текущий день", async () => {
    await seed({ created: "2026-09-30T18:00:00Z" }); // сентябрь
    await seed({ created: "2026-10-01T10:00:00Z" });
    await seed({ created: "2026-10-31T10:00:00Z" });
    const r = await buildReport("monthly", at("2026-10-31T15:00:00Z"), TZ);
    expect(r).toMatchObject({ total: 2, label: "октябрь 2026", period: "2026-10" });
  });
});

describe("тексты отчётов", () => {
  it("экранируют данные и содержат ключевые цифры; предупреждение о таблице показывается при сбоях", async () => {
    await seed({ created: "2026-10-20T05:00:00Z", published: "2026-10-20T05:00:00Z", claimedAt: "2026-10-20T05:03:00Z", manager: [1, "<b>Алиса</b>", "Менеджер 1"] });
    db.collection("leads").docs[0].sheet.status = "failed";
    const r = aggregateReport([db.collection("leads").docs[0] as Lead], { kind: "monthly", label: "октябрь 2026", period: "2026-10", from: at("2026-09-30T19:00:00Z"), to: at("2026-10-31T19:00:00Z") });

    const tg = renderReportTelegram(r);
    expect(tg).toContain("Отчёт за месяц — октябрь 2026");
    expect(tg).toContain("&lt;b&gt;Алиса&lt;/b&gt;");
    expect(tg).not.toContain("<b>Алиса</b>");
    expect(tg).toContain("Не записано в таблицу: 1");
    expect(tg).toContain("3 мин");

    const mail = renderReportEmail(r);
    expect(mail.subject).toBe("Sunrise CRM: Отчёт за месяц — октябрь 2026");
    expect(mail.html).toContain("&lt;b&gt;Алиса&lt;/b&gt;");
    expect(mail.text).toContain("Менеджер 1");
  });
});

describe("sendReport", () => {
  const NOW = at("2026-10-20T15:00:00Z");
  const make = (over: Partial<ReportDeps> = {}) => ({ tz: TZ, sendTelegram: jest.fn(async () => undefined), sendEmail: jest.fn(async () => undefined), ...over });

  it("отправляет в Telegram и на почту один раз за период", async () => {
    const deps = make();
    expect(await sendReport("daily", NOW, deps)).toBe("sent");
    expect(await sendReport("daily", NOW, deps)).toBe("skipped");
    expect(deps.sendTelegram).toHaveBeenCalledTimes(1);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(await sendReport("daily", at("2026-10-21T15:00:00Z"), deps)).toBe("sent"); // другой день
  });

  it("если доставка провалилась везде — ошибка, слот освобождён и повтор возможен", async () => {
    const failing = make({ sendTelegram: jest.fn(async () => { throw new Error("tg down"); }), sendEmail: jest.fn(async () => { throw new Error("smtp down"); }) });
    await expect(sendReport("daily", NOW, failing)).rejects.toThrow(/ни в один канал/);
    expect(await sendReport("daily", NOW, make())).toBe("sent");
  });

  it("если сбой в одном канале — отчёт считается отправленным (слот остаётся)", async () => {
    const deps = make({ sendEmail: jest.fn(async () => { throw new Error("smtp down"); }) });
    expect(await sendReport("daily", NOW, deps)).toBe("sent");
    expect(await sendReport("daily", NOW, make())).toBe("skipped");
  });

  it("почта не настроена — отчёт уходит только в Telegram; force обходит идемпотентность", async () => {
    const deps = make({ sendEmail: undefined });
    await sendReport("daily", NOW, deps);
    expect(deps.sendTelegram).toHaveBeenCalledTimes(1);
    expect(await sendReport("daily", NOW, deps, { force: true })).toBe("sent");
    expect(deps.sendTelegram).toHaveBeenCalledTimes(2);
  });
});

