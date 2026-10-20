import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { resetIndexCacheForTests } from "@/lib/db/collections";
import {
  claimLead,
  createLeadIfNew,
  findStaleForEscalation,
  InvalidPhoneError,
  listSheetSyncCandidates,
  listUnpublished,
  lockForPublish,
  lockForSheetSync,
  markEscalated,
  markPublished,
  markSheetFailed,
  markSheetSynced,
  type ClaimActor,
} from "@/lib/db/leads";
import { deactivateManager, getActiveManager, listActiveManagers, upsertManager } from "@/lib/db/managers";
import { claimEvent, claimReportSlot } from "@/lib/db/events";
import { getOrCreateSession, MAX_SESSION_MESSAGES, saveSession } from "@/lib/db/sessions";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  resetIndexCacheForTests();
});

const base = { name: "Алишер", phone: "+992 93 123 45 67", source: "WhatsApp", channel: "whatsapp" } as const;
const actor = (id: number, sheet: ClaimActor["sheetName"] = "Менеджер 1"): ClaimActor => ({ telegramId: id, name: `М${id}`, sheetName: sheet });
const T0 = new Date("2026-10-20T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe("createLeadIfNew — дедупликация", () => {
  it("создаёт лид: нормализованный телефон, стадия «Новый лид», статус pending", async () => {
    const r = await createLeadIfNew(base, T0);
    expect(r.kind).toBe("created");
    expect(r.lead).toMatchObject({ phone: "992931234567", stage: "Новый лид", status: "pending", contactCount: 1 });
    expect(r.lead.sheet).toMatchObject({ status: "waiting", attempts: 0 });
  });

  it("тот же клиент в другом формате номера — дубликат, счётчик контактов растёт", async () => {
    await createLeadIfNew(base, T0);
    const again = await createLeadIfNew({ ...base, phone: "931234567", source: "Таргет Facebook" }, minutes(5));
    expect(again.kind).toBe("duplicate");
    expect(again.lead.contactCount).toBe(2);
    expect(again.lead.source).toBe("WhatsApp"); // первоначальный источник не перезаписывается
    expect(db.collection("leads").docs).toHaveLength(1);
  });

  it("пять одновременных вебхуков про одного клиента дают ровно один лид", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => createLeadIfNew(base, T0)));
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(db.collection("leads").docs).toHaveLength(1);
  });

  it("отклоняет неверный телефон и источник вне справочника", async () => {
    await expect(createLeadIfNew({ ...base, phone: "123" })).rejects.toBeInstanceOf(InvalidPhoneError);
    await expect(createLeadIfNew({ ...base, source: "Instagram Direct" as never })).rejects.toThrow(/_Lists/);
  });

  it("ручной лид с claimBy сразу закреплён и ждёт записи в таблицу", async () => {
    const r = await createLeadIfNew({ ...base, claimBy: actor(7, "Менеджер 2") }, T0);
    expect(r.lead).toMatchObject({ status: "claimed", claim: { managerId: 7, sheetName: "Менеджер 2" } });
    expect(r.lead.sheet.status).toBe("pending");
    expect(await listUnpublished()).toHaveLength(0); // в общую группу не попадает
  });
});

describe("claimLead — Shark Tank", () => {
  it("при одновременных нажатиях выигрывает ровно один менеджер", async () => {
    const { lead } = await createLeadIfNew(base, T0);
    const results = await Promise.all([1, 2, 3, 4].map((id) => claimLead(lead._id.toHexString(), actor(id), T0)));

    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const winner = winners[0] as { ok: true; lead: { claim: { managerId: number } } };

    for (const r of results.filter((x) => !x.ok)) {
      expect(r).toMatchObject({ ok: false, reason: "already_claimed" });
      if (!r.ok && r.reason === "already_claimed") expect(r.lead.claim?.managerId).toBe(winner.lead.claim.managerId);
    }
    const stored = db.collection("leads").docs[0];
    expect(stored.status).toBe("claimed");
    expect(stored.sheet.status).toBe("pending");
  });

  it("повторное нажатие победителя — тоже отказ (лид уже закреплён)", async () => {
    const { lead } = await createLeadIfNew(base, T0);
    await claimLead(lead._id.toHexString(), actor(1), T0);
    expect(await claimLead(lead._id.toHexString(), actor(1), T0)).toMatchObject({ ok: false, reason: "already_claimed" });
  });

  it("несуществующий и некорректный id", async () => {
    expect(await claimLead(new ObjectId().toHexString(), actor(1))).toEqual({ ok: false, reason: "missing" });
    expect(await claimLead("not-an-id", actor(1))).toEqual({ ok: false, reason: "missing" });
  });
});

describe("публикация карточки", () => {
  it("блокировка не даёт опубликовать дважды; протухшая блокировка снимается", async () => {
    const { lead } = await createLeadIfNew(base, T0);
    expect(await lockForPublish(lead._id, T0)).not.toBeNull();
    expect(await lockForPublish(lead._id, minutes(0.5))).toBeNull();
    expect(await lockForPublish(lead._id, minutes(2))).not.toBeNull(); // старше 60 с
  });

  it("после markPublished лид не попадает ни в очередь публикации, ни в блокировку", async () => {
    const { lead } = await createLeadIfNew(base, T0);
    expect(await listUnpublished()).toHaveLength(1);
    await markPublished(lead._id, { chatId: -100, messageId: 5 }, T0);
    expect(await listUnpublished()).toHaveLength(0);
    expect(await lockForPublish(lead._id, minutes(5))).toBeNull();
  });
});

describe("эскалация через 15 минут", () => {
  it("находит только неклаймнутые карточки старше порога и отмечает ровно один раз", async () => {
    const a = (await createLeadIfNew({ ...base, phone: "992931111111" }, T0)).lead;
    const b = (await createLeadIfNew({ ...base, phone: "992932222222" }, T0)).lead;
    const c = (await createLeadIfNew({ ...base, phone: "992933333333" }, T0)).lead;
    await markPublished(a._id, { chatId: 1, messageId: 1 }, T0); // старая
    await markPublished(b._id, { chatId: 1, messageId: 2 }, minutes(10)); // свежая
    await markPublished(c._id, { chatId: 1, messageId: 3 }, T0); // старая, но заберут
    await claimLead(c._id.toHexString(), actor(1), minutes(3));

    const stale = await findStaleForEscalation(minutes(15 - 15)); // cutoff = now - 15 мин при now = T0+15
    expect(stale.map((l) => l.phone)).toEqual(["992931111111"]);

    expect(await markEscalated(a._id, minutes(15))).not.toBeNull();
    expect(await markEscalated(a._id, minutes(16))).toBeNull(); // повторно не тегаем
    expect(await findStaleForEscalation(minutes(0))).toHaveLength(0);
  });
});

describe("синхронизация с Google Sheets", () => {
  async function claimed() {
    const { lead } = await createLeadIfNew(base, T0);
    await claimLead(lead._id.toHexString(), actor(1), T0);
    return lead;
  }

  it("захват записи атомарен; сбой допускает повтор до лимита попыток", async () => {
    const lead = await claimed();
    const first = await lockForSheetSync(lead._id, 3, T0);
    expect(first?.sheet).toMatchObject({ status: "syncing", attempts: 1 });
    expect(await lockForSheetSync(lead._id, 3, minutes(0.1))).toBeNull(); // уже пишет другой воркер

    await markSheetFailed(lead._id, "quota");
    expect((await lockForSheetSync(lead._id, 3, minutes(1)))?.sheet.attempts).toBe(2);
    await markSheetFailed(lead._id, "quota");
    expect((await lockForSheetSync(lead._id, 3, minutes(2)))?.sheet.attempts).toBe(3);
    await markSheetFailed(lead._id, "quota");
    expect(await lockForSheetSync(lead._id, 3, minutes(3))).toBeNull(); // лимит исчерпан
  });

  it("зависшая запись (syncing > 2 мин) подхватывается заново", async () => {
    const lead = await claimed();
    await lockForSheetSync(lead._id, 5, T0);
    expect(await listSheetSyncCandidates(5, minutes(1))).toHaveLength(0);
    expect(await listSheetSyncCandidates(5, minutes(3))).toHaveLength(1);
  });

  it("после успеха лид не возвращается в очередь", async () => {
    const lead = await claimed();
    await lockForSheetSync(lead._id, 5, T0);
    await markSheetSynced(lead._id, { sheetName: "Менеджер 1", row: 7 }, T0);
    expect(await lockForSheetSync(lead._id, 5, minutes(10))).toBeNull();
    expect(db.collection("leads").docs[0].sheet).toMatchObject({ status: "synced", row: 7, sheetName: "Менеджер 1" });
  });

  it("лид без закрепления в таблицу не пишется", async () => {
    const { lead } = await createLeadIfNew(base, T0);
    expect(await lockForSheetSync(lead._id, 5, T0)).toBeNull();
  });
});

describe("менеджеры", () => {
  it("регистрация, один лист — один менеджер, деактивация", async () => {
    await upsertManager({ telegramId: 1, name: "Алиса", sheetName: "Менеджер 1" });
    await upsertManager({ telegramId: 2, name: "Бобо", sheetName: "Менеджер 2" });
    await expect(upsertManager({ telegramId: 3, name: "Вали", sheetName: "Менеджер 1" })).rejects.toThrow(/занят/);
    await expect(upsertManager({ telegramId: 3, name: "Вали", sheetName: "Менеджер 9" as never })).rejects.toThrow(/Нет листа/);

    expect((await listActiveManagers()).map((m) => m.name)).toEqual(["Алиса", "Бобо"]);
    expect(await deactivateManager(1)).toBe(true);
    expect(await getActiveManager(1)).toBeNull();
    // освободившийся лист можно отдать другому
    await upsertManager({ telegramId: 3, name: "Вали", sheetName: "Менеджер 1" });
  });
});

describe("события, отчёты, сессии", () => {
  it("claimEvent: первое событие новое, повтор — дубликат", async () => {
    expect(await claimEvent("wa:ABC")).toBe(true);
    expect(await claimEvent("wa:ABC")).toBe(false);
    expect(await claimEvent("wa:XYZ")).toBe(true);
  });

  it("слот отчёта выдаётся один раз на период", async () => {
    expect(await claimReportSlot("daily", "2026-10-20")).toBe(true);
    expect(await claimReportSlot("daily", "2026-10-20")).toBe(false);
    expect(await claimReportSlot("monthly", "2026-10")).toBe(true);
  });

  it("сессия: upsert идемпотентен, история ограничена", async () => {
    const s1 = await getOrCreateSession("whatsapp", "992931234567", "992931234567@s.whatsapp.net", T0);
    const s2 = await getOrCreateSession("whatsapp", "992931234567", "992931234567@s.whatsapp.net", minutes(1));
    expect(s2._id.equals(s1._id)).toBe(true);
    expect(s2.state.userTurns).toBe(0);

    const messages = Array.from({ length: MAX_SESSION_MESSAGES + 10 }, (_, i) => ({ role: "user" as const, text: `m${i}`, at: T0 }));
    await saveSession(s1._id, { messages, state: { userTurns: 3, floor: 5 } }, T0);
    const saved = db.collection("sessions").docs[0];
    expect(saved.messages).toHaveLength(MAX_SESSION_MESSAGES);
    expect(saved.messages.at(-1).text).toBe(`m${MAX_SESSION_MESSAGES + 9}`);
    expect(saved.state).toEqual({ userTurns: 3, floor: 5 });
  });
});
