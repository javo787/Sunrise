import { getDb } from "@/lib/mongodb";
import { resetIndexCacheForTests, type Lead } from "@/lib/db/collections";
import { getLead, markPublished, type NewLeadInput } from "@/lib/db/leads";
import { upsertManager } from "@/lib/db/managers";
import {
  escalateStaleLeads,
  fallbackContactAlert,
  handleClaim,
  publishLead,
  publishPendingLeads,
  registerLead,
  type PipelineDeps,
} from "@/lib/services/lead-pipeline";
import { claimedKeyboard, renderClaimedCard, renderContactDm, renderEscalation, renderLeadCard } from "@/lib/telegram/cards";
import type { TelegramGateway } from "@/lib/telegram/gateway";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

let db: FakeDb;
let nextMessageId: number;
let gateway: jest.Mocked<TelegramGateway>;
let syncSheet: jest.Mock;
let deps: PipelineDeps;
const noDm = new Set<number>();

beforeEach(async () => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  resetIndexCacheForTests();
  nextMessageId = 100;
  noDm.clear();
  gateway = {
    sendCard: jest.fn(async () => ({ chatId: -1001, messageId: nextMessageId++ })),
    markClaimed: jest.fn(async () => undefined),
    sendDm: jest.fn(async (userId: number) => !noDm.has(userId)),
    sendGroupHtml: jest.fn(async () => undefined),
    sendTo: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<TelegramGateway>;
  syncSheet = jest.fn(async () => undefined);
  deps = { gateway, syncSheet, adminIds: [9000], escalationMinutes: 15 };

  await upsertManager({ telegramId: 1, name: "Алиса", sheetName: "Менеджер 1" });
  await upsertManager({ telegramId: 2, name: "Бобо", sheetName: "Менеджер 2" });
  await upsertManager({ telegramId: 3, name: "Вали", sheetName: "Менеджер 3" });
});

const input: NewLeadInput = { name: "Алишер", phone: "+992 93 123 45 67", source: "Таргет Instagram", channel: "meta_form", qualification: { floor: 5, areaSqm: 45, paymentType: "installment_50" } };
const T0 = new Date("2026-10-20T10:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

async function newLead(over: Partial<NewLeadInput> = {}): Promise<Lead> {
  const r = await registerLead(deps, { ...input, ...over });
  return r.lead;
}

describe("публикация карточки", () => {
  it("новый лид уходит в группу: карточка с кнопкой, номер скрыт", async () => {
    const lead = await newLead();
    expect(gateway.sendCard).toHaveBeenCalledTimes(1);
    const stored = await getLead(lead._id.toHexString());
    expect(stored).toMatchObject({ status: "pending", card: { chatId: -1001, messageId: 100 } });
    expect(stored?.publishedAt).toBeInstanceOf(Date);

    const text = renderLeadCard(lead);
    // ищем «+992» и полные цифры номера, а не «992»: случайный #ID карточки может содержать эти символы
    expect(text).not.toMatch(/\+992|992931234567|931234567|123 45 67/);
    expect(text).toContain("Номер скрыт");
    expect(text).toContain("этаж 5 · 45 м²");
    expect(text).toContain("$56 700"); // ориентир по прайсу: 45 м² × $1 260
  });

  it("Telegram недоступен → лид сохранён, блокировка снята, cron публикует позже", async () => {
    gateway.sendCard.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const lead = await newLead();
    expect((await getLead(lead._id.toHexString()))?.publishedAt).toBeUndefined();

    expect(await publishPendingLeads(gateway)).toBe(1);
    expect((await getLead(lead._id.toHexString()))?.publishedAt).toBeInstanceOf(Date);
    expect(await publishPendingLeads(gateway)).toBe(0);
  });

  it("повторная публикация одного лида невозможна", async () => {
    const lead = await newLead();
    expect(await publishLead(gateway, lead)).toBe(false);
    expect(gateway.sendCard).toHaveBeenCalledTimes(1);
  });

  it("дубликат клиента не создаёт карточку; закреплённый менеджер получает уведомление", async () => {
    const lead = await newLead();
    await handleClaim(deps, lead._id.toHexString(), { id: 2 });
    gateway.sendDm.mockClear();
    gateway.sendCard.mockClear();

    const again = await registerLead(deps, { ...input, phone: "931234567", source: "WhatsApp", channel: "whatsapp" });
    expect(again.kind).toBe("duplicate");
    expect(gateway.sendCard).not.toHaveBeenCalled();
    expect(gateway.sendDm).toHaveBeenCalledWith(2, expect.stringContaining("написал повторно"));
  });

  it("ручной лид с claimBy в группу не попадает и сразу уходит в таблицу", async () => {
    const r = await registerLead(deps, { ...input, channel: "manual", source: "Звонок входящий", claimBy: { telegramId: 1, name: "Алиса", sheetName: "Менеджер 1" } });
    expect(r.lead.status).toBe("claimed");
    expect(gateway.sendCard).not.toHaveBeenCalled();
    expect(syncSheet).toHaveBeenCalledTimes(1);
  });
});

describe("Shark Tank: handleClaim", () => {
  it("одновременные клики трёх менеджеров: победитель один, остальные получают отказ", async () => {
    const lead = await newLead();
    const outcomes = await Promise.all([1, 2, 3].map((id) => handleClaim(deps, lead._id.toHexString(), { id })));

    const won = outcomes.filter((o) => o.kind === "won");
    const lost = outcomes.filter((o) => o.kind === "lost");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);

    const winner = won[0] as Extract<(typeof outcomes)[number], { kind: "won" }>;
    for (const l of lost) expect((l as { winnerName?: string }).winnerName).toBe(winner.lead.claim?.managerName);

    await winner.sheetSync;
    expect(gateway.markClaimed).toHaveBeenCalledTimes(1);
    expect(syncSheet).toHaveBeenCalledTimes(1);
    expect(gateway.sendDm).toHaveBeenCalledTimes(1);
    expect(gateway.sendDm.mock.calls[0][0]).toBe(winner.lead.claim?.managerId);
    expect(String(gateway.sendDm.mock.calls[0][1])).toContain("+992 93 123 45 67"); // номер — только победителю
  });

  it("победитель получает контакт и лист; карточка в группе меняется на «✅ Забрал»", async () => {
    const lead = await newLead();
    const out = await handleClaim(deps, lead._id.toHexString(), { id: 2 });
    expect(out).toMatchObject({ kind: "won", dmDelivered: true });

    const [card, claimed] = gateway.markClaimed.mock.calls[0];
    expect(card).toEqual({ chatId: -1001, messageId: 100 });
    expect(renderClaimedCard(claimed, "Asia/Dushanbe")).toContain("Забрал: Бобо");
    expect(renderClaimedCard(claimed, "Asia/Dushanbe")).not.toContain("+992");
    expect(JSON.stringify(claimedKeyboard("Бобо"))).toContain("✅ Забрал: Бобо");
    expect(renderContactDm(claimed)).toContain("лист «Менеджер 2»");
  });

  it("личка недоступна (менеджер не нажал /start) → лид всё равно закреплён, контакт отдаётся во всплывающем окне", async () => {
    noDm.add(1);
    const lead = await newLead();
    const out = await handleClaim(deps, lead._id.toHexString(), { id: 1 });
    expect(out).toMatchObject({ kind: "won", dmDelivered: false });
    if (out.kind === "won") {
      const alert = fallbackContactAlert(out.lead);
      expect(alert).toContain("+992 93 123 45 67");
      expect(alert.length).toBeLessThanOrEqual(200);
    }
  });

  it("не менеджер не может забрать лид; неизвестный лид; сбой правки карточки не отменяет захват", async () => {
    const lead = await newLead();
    expect(await handleClaim(deps, lead._id.toHexString(), { id: 777 })).toEqual({ kind: "not_manager" });
    expect((await getLead(lead._id.toHexString()))?.status).toBe("pending");
    expect(await handleClaim(deps, "64b64b64b64b64b64b64b64b", { id: 1 })).toEqual({ kind: "missing" });

    gateway.markClaimed.mockRejectedValueOnce(new Error("message to edit not found"));
    expect(await handleClaim(deps, lead._id.toHexString(), { id: 3 })).toMatchObject({ kind: "won", dmDelivered: true });
  });
});

describe("эскалация", () => {
  async function publishedAt(lead: Lead, at: Date) {
    await markPublished(lead._id, { chatId: -1001, messageId: 555 }, at);
  }

  it("через 15 минут тегает менеджеров и руководителя — один раз", async () => {
    const lead = await newLead();
    await publishedAt(lead, T0);

    expect(await escalateStaleLeads(deps, minutes(14))).toBe(0);
    expect(await escalateStaleLeads(deps, minutes(16))).toBe(1);

    const [html, replyTo] = gateway.sendGroupHtml.mock.calls[0];
    expect(replyTo).toBe(555);
    expect(html).toContain("не забран уже 16 мин");
    for (const id of [1, 2, 3, 9000]) expect(html).toContain(`tg://user?id=${id}`);
    expect(html).toContain("Руководитель");

    expect(await escalateStaleLeads(deps, minutes(40))).toBe(0); // повторно не тегаем
  });

  it("забранные лиды не эскалируются; при сбое отправки эскалация повторяется", async () => {
    const claimed = await newLead({ phone: "992931111111" });
    await publishedAt(claimed, T0);
    await handleClaim(deps, claimed._id.toHexString(), { id: 1 });

    const pending = await newLead({ phone: "992932222222" });
    await publishedAt(pending, T0);
    gateway.sendGroupHtml.mockRejectedValueOnce(new Error("Telegram 502"));

    expect(await escalateStaleLeads(deps, minutes(20))).toBe(0); // отправка упала
    expect(await escalateStaleLeads(deps, minutes(21))).toBe(1); // отметка откатилась — повтор успешен
    expect(gateway.sendGroupHtml).toHaveBeenCalledTimes(2);
    expect(String(gateway.sendGroupHtml.mock.calls[1][0])).toContain("Алишер");
  });
});

describe("карточки", () => {
  it("пользовательский текст экранируется под HTML", async () => {
    const lead = await newLead({ name: "<b>Хак</b> & Ко" });
    const text = renderLeadCard(lead);
    expect(text).toContain("&lt;b&gt;Хак&lt;/b&gt; &amp; Ко");
    expect(text).not.toContain("<b>Хак</b>");
    expect(renderEscalation(lead, 15, [{ id: 1, name: "<i>x</i>" }])).toContain("&lt;i&gt;x&lt;/i&gt;");
  });

  it("этаж вне прайса не ломает карточку", async () => {
    const lead = await newLead({ phone: "992939999999", qualification: { floor: 25, paymentType: "full_100" } as never });
    expect(renderLeadCard(lead)).toContain("цены по этому этажу в прайсе нет");
  });
});
