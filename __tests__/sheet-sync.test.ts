import { getDb } from "@/lib/mongodb";
import { resetConfigCache } from "@/lib/config";
import { resetIndexCacheForTests } from "@/lib/db/collections";
import { claimLead, createLeadIfNew } from "@/lib/db/leads";
import { retryPendingSheetSyncs, syncLeadToSheet } from "@/lib/services/sheet-sync";
import { FakeDb } from "./helpers/fake-mongo";
import { FakeSheets } from "./helpers/fake-sheets";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

const HEADER = ["Дата", "Имя клиента", "Телефон", "Источник", "Стадия", "Этаж", "Площадь, м²", "Вид оплаты", "Комментарий", "Сумма сделки"];
let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  resetIndexCacheForTests();
  Object.assign(process.env, {
    MONGODB_URI: "mongodb://x",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    SHEETS_SPREADSHEET_ID: "sheet-id",
  });
  resetConfigCache();
});

async function claimedLead() {
  const { lead } = await createLeadIfNew({ name: "Алишер", phone: "+992931234567", source: "WhatsApp", channel: "whatsapp", qualification: { floor: 7 } });
  await claimLead(lead._id.toHexString(), { telegramId: 1, name: "Алиса", sheetName: "Менеджер 2" });
  return lead;
}

describe("syncLeadToSheet", () => {
  it("записывает лид на лист победившего менеджера и отмечает в БД", async () => {
    const lead = await claimedLead();
    const api = new FakeSheets({ "Менеджер 2": [HEADER] });

    expect(await syncLeadToSheet(lead, api)).toBe("synced");
    expect(api.cell("Менеджер 2", 2, 1)).toBe("Алишер");
    expect(api.cell("Менеджер 2", 2, 5)).toBe("7");
    expect(db.collection("leads").docs[0].sheet).toMatchObject({ status: "synced", row: 2, sheetName: "Менеджер 2" });

    expect(await syncLeadToSheet(lead, api)).toBe("skipped"); // повторно не пишет
  });

  it("сбой API → failed; cron-повтор успешно дописывает без дублей", async () => {
    const lead = await claimedLead();
    const api = new FakeSheets({ "Менеджер 2": [HEADER] });
    api.failWrites = true;

    expect(await syncLeadToSheet(lead, api)).toBe("failed");
    expect(db.collection("leads").docs[0].sheet).toMatchObject({ status: "failed", attempts: 1 });
    expect(db.collection("leads").docs[0].sheet.error).toMatch(/503/);

    api.failWrites = false;
    expect(await retryPendingSheetSyncs(api)).toEqual({ synced: 1, failed: 0 });
    expect(api.grids.get("Менеджер 2")).toHaveLength(2); // заголовок + одна строка
    expect(await retryPendingSheetSyncs(api)).toEqual({ synced: 0, failed: 0 });
  });

  it("лист без нужных колонок: ошибка фиксируется, строка не пишется", async () => {
    const lead = await claimedLead();
    const api = new FakeSheets({ "Менеджер 2": [["Что-то", "Другое"]] });
    expect(await syncLeadToSheet(lead, api)).toBe("failed");
    expect(db.collection("leads").docs[0].sheet.error).toMatch(/не найдены колонки/);
    expect(api.writes).toHaveLength(0);
  });
});
