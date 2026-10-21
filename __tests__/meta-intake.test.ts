import { getDb } from "@/lib/mongodb";
import { resetIndexCacheForTests } from "@/lib/db/collections";
import { createLeadIfNew } from "@/lib/db/leads";
import { META_LEADGEN_FAILURE, processLeadgen, processMetaPayload, retryFailedLeadgens, type MetaIntakeDeps } from "@/lib/services/meta-intake";
import type { MetaLead } from "@/lib/integrations/meta";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

let db: FakeDb;
let fetchLead: jest.Mock<Promise<MetaLead>, [string]>;
let push: jest.Mock;
let deps: MetaIntakeDeps;

const form = (over: Partial<MetaLead> = {}): MetaLead => ({ id: "L1", platform: "ig", fields: { full_name: "Алишер", phone_number: "+992 93 123 45 67", "какой_этаж?": "5" }, ...over });

beforeEach(() => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  resetIndexCacheForTests();
  fetchLead = jest.fn(async (_leadgenId: string) => form());
  push = jest.fn();
  deps = { fetchLead, batcher: { push }, registerLead: (input) => createLeadIfNew(input) };
});

const leads = () => db.collection("leads").docs;
const failures = () => db.collection("failed_events").docs;

describe("лид-форма Meta", () => {
  it("создаёт лид: источник по платформе, телефон нормализован, анкета в комментарии", async () => {
    expect(await processLeadgen("L1", deps)).toBe("created");
    expect(leads()[0]).toMatchObject({ name: "Алишер", phone: "992931234567", source: "Таргет Instagram", channel: "meta_form", externalId: "L1", status: "pending", stage: "Новый лид" });
    expect(leads()[0].summary).toContain("какой этаж?: 5");
  });

  it("Facebook-форма → «Таргет Facebook»", async () => {
    fetchLead.mockResolvedValue(form({ platform: "fb" }));
    await processLeadgen("L2", deps);
    expect(leads()[0].source).toBe("Таргет Facebook");
  });

  it("повторная доставка того же leadgen_id не создаёт второй лид и не обращается к Graph API", async () => {
    await processLeadgen("L1", deps);
    expect(await processLeadgen("L1", deps)).toBe("duplicate");
    expect(fetchLead).toHaveBeenCalledTimes(1);
    expect(leads()).toHaveLength(1);
  });

  it("тот же клиент из другой формы — дубликат по телефону", async () => {
    await processLeadgen("L1", deps);
    expect(await processLeadgen("L9", deps)).toBe("duplicate");
    expect(leads()).toHaveLength(1);
    expect(leads()[0].contactCount).toBe(2);
  });

  it("нет корректного телефона: лид не создаётся, анкета сохраняется в журнал для ручной обработки", async () => {
    fetchLead.mockResolvedValue(form({ fields: { full_name: "Без номера", email: "a@b.tj" } }));
    expect(await processLeadgen("L3", deps)).toBe("skipped_no_phone");
    expect(leads()).toHaveLength(0);
    expect(failures()[0]).toMatchObject({ kind: "meta_lead_no_phone" });
  });
});

describe("сбой Graph API и повтор", () => {
  it("при сбое событие записывается в журнал и освобождается для повтора", async () => {
    fetchLead.mockRejectedValue(new Error("Graph API 500"));
    expect(await processLeadgen("L1", deps)).toBe("failed");
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({ kind: META_LEADGEN_FAILURE, payload: { leadgenId: "L1" } });
    expect(db.collection("events").docs).toHaveLength(0); // отметка снята — повтор не будет принят за дубликат
  });

  it("cron-повтор получает лид и убирает запись из журнала", async () => {
    fetchLead.mockRejectedValueOnce(new Error("Graph API 500"));
    await processLeadgen("L1", deps);

    expect(await retryFailedLeadgens(deps)).toEqual({ retried: 1, recovered: 1 });
    expect(leads()).toHaveLength(1);
    expect(failures()).toHaveLength(0);
  });

  it("если повтор снова неудачен — запись остаётся и не размножается", async () => {
    fetchLead.mockRejectedValue(new Error("Graph API 500"));
    await processLeadgen("L1", deps);
    expect(await retryFailedLeadgens(deps)).toEqual({ retried: 1, recovered: 0 });
    expect(await retryFailedLeadgens(deps)).toEqual({ retried: 1, recovered: 0 });
    expect(failures()).toHaveLength(1);
  });

  it("сбои старше 24 часов не повторяются", async () => {
    fetchLead.mockRejectedValue(new Error("Graph API 500"));
    await processLeadgen("L1", deps);
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await retryFailedLeadgens(deps, later)).toEqual({ retried: 0, recovered: 0 });
  });
});

describe("processMetaPayload", () => {
  it("лид-формы и сообщения Instagram: эхо и вложения без текста пропускаются, повторы отсекаются", async () => {
    const body = {
      object: "page",
      entry: [
        { changes: [{ field: "leadgen", value: { leadgen_id: "L1" } }] },
        {
          messaging: [
            { sender: { id: "U1" }, message: { mid: "m1", text: "Здравствуйте" } },
            { sender: { id: "U1" }, message: { mid: "m1", text: "Здравствуйте" } },
            { sender: { id: "PAGE" }, message: { mid: "m2", text: "наш ответ", is_echo: true } },
            { sender: { id: "U2" }, message: { mid: "m3" } },
          ],
        },
      ],
    };
    const stats = await processMetaPayload(body, deps);
    expect(stats).toEqual({ leadgens: 1, messages: 1, duplicates: 1 });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("instagram:U1", { channel: "instagram", contactId: "U1", replyTo: "U1", text: "Здравствуйте" });
    expect(leads()).toHaveLength(1);
  });

  it("пустой и мусорный payload не ломают обработку", async () => {
    expect(await processMetaPayload({}, deps)).toEqual({ leadgens: 0, messages: 0, duplicates: 0 });
    expect(await processMetaPayload(null, deps)).toEqual({ leadgens: 0, messages: 0, duplicates: 0 });
  });
});
