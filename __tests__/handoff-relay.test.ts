import { getDb } from "@/lib/mongodb";
import { resetIndexCacheForTests } from "@/lib/db/collections";
import { claimLead, createLeadIfNew, markPublished } from "@/lib/db/leads";
import { relayClientMessage } from "@/lib/services/handoff-relay";
import type { InboundMessage } from "@/lib/services/sales-bot";
import type { TelegramGateway } from "@/lib/telegram/gateway";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

let gateway: jest.Mocked<TelegramGateway>;
beforeEach(() => {
  (getDb as jest.Mock).mockResolvedValue(new FakeDb());
  resetIndexCacheForTests();
  gateway = { sendDm: jest.fn(async () => true), sendGroupHtml: jest.fn(async () => undefined) } as unknown as jest.Mocked<TelegramGateway>;
});

const msg = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({ channel: "whatsapp", contactId: "992931234567", replyTo: "992931234567", text, ...over });
const lead = async () => (await createLeadIfNew({ name: "Алишер", phone: "992931234567", source: "WhatsApp", channel: "whatsapp" })).lead;

describe("relayClientMessage", () => {
  it("лид закреплён: сообщение уходит менеджеру в личку вместе с телефоном", async () => {
    const l = await lead();
    await claimLead(l._id.toHexString(), { telegramId: 5, name: "Алиса", sheetName: "Менеджер 1" });
    expect(await relayClientMessage({ gateway }, { leadId: l._id }, [msg("а когда сдача?"), msg("и есть ли парковка")])).toBe("dm");

    const [userId, html] = gateway.sendDm.mock.calls[0];
    expect(userId).toBe(5);
    expect(html).toContain("а когда сдача?\nи есть ли парковка");
    expect(html).toContain("+992 93 123 45 67");
    expect(html).toContain("WhatsApp");
  });

  it("лид ещё не забран: ответ в треде карточки, без телефона", async () => {
    const l = await lead();
    await markPublished(l._id, { chatId: -1001, messageId: 77 });
    expect(await relayClientMessage({ gateway }, { leadId: l._id }, [msg("жду звонка")])).toBe("group");

    const [html, replyTo] = gateway.sendGroupHtml.mock.calls[0];
    expect(replyTo).toBe(77);
    expect(html).toContain("жду звонка");
    expect(html).not.toMatch(/\+992|931234567|123 45 67/); // телефона в группе нет (случайный #ID может содержать «992»)
    expect(gateway.sendDm).not.toHaveBeenCalled();
  });

  it("голосовое без текста — пометка; экранирование HTML; нечего пересылать — none", async () => {
    const l = await lead();
    await claimLead(l._id.toHexString(), { telegramId: 5, name: "Алиса", sheetName: "Менеджер 1" });

    await relayClientMessage({ gateway }, { leadId: l._id }, [msg("", { audio: { base64: "x", mimeType: "audio/ogg" } })]);
    expect(gateway.sendDm.mock.calls[0][1]).toContain("[голосовое сообщение]");

    await relayClientMessage({ gateway }, { leadId: l._id }, [msg("<script>alert(1)</script>")]);
    expect(gateway.sendDm.mock.calls[1][1]).toContain("&lt;script&gt;");

    expect(await relayClientMessage({ gateway }, { leadId: l._id }, [msg("")])).toBe("none");
    expect(await relayClientMessage({ gateway }, {}, [msg("привет")])).toBe("none");
  });

  it("менеджер недоступен в личке — none, без исключения", async () => {
    const l = await lead();
    await claimLead(l._id.toHexString(), { telegramId: 5, name: "Алиса", sheetName: "Менеджер 1" });
    gateway.sendDm.mockResolvedValue(false);
    expect(await relayClientMessage({ gateway }, { leadId: l._id }, [msg("привет")])).toBe("none");
  });
});
