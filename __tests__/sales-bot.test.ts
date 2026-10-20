import { getDb } from "@/lib/mongodb";
import { resetIndexCacheForTests } from "@/lib/db/collections";
import { createLeadIfNew } from "@/lib/db/leads";
import type { LlmClient, LlmExtraction, LlmResult } from "@/lib/integrations/llm";
import { LlmUnavailableError } from "@/lib/integrations/llm";
import { handleInboundBatch, isQualified, type InboundMessage, type SalesBotDeps } from "@/lib/services/sales-bot";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

let db: FakeDb;
const ex = (over: Partial<LlmExtraction> = {}): LlmExtraction => ({
  floor: null, areaSqm: null, paymentType: null, phone: null, name: null, language: "ru", wantsHuman: false, summary: "", ...over,
});
const res = (reply: string, over: Partial<LlmExtraction> = {}): LlmResult => ({ reply, extraction: ex(over) });

let llm: { supportsAudio: boolean; generate: jest.Mock };
let sendBubbles: jest.Mock;
let deps: SalesBotDeps;

beforeEach(() => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  resetIndexCacheForTests();
  llm = { supportsAudio: false, generate: jest.fn() };
  sendBubbles = jest.fn(async () => undefined);
  deps = {
    llm: llm as unknown as LlmClient,
    sendBubbles,
    registerLead: (input) => createLeadIfNew(input),
    maxUserTurns: 4,
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() } as never,
  };
});

const wa = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "whatsapp", contactId: "992931234567", replyTo: "992931234567", phone: "992931234567", name: "Алишер", text, ...over,
});
const ig = (text: string): InboundMessage => ({ channel: "instagram", contactId: "IG1", replyTo: "IG1", text });
const sent = () => sendBubbles.mock.calls.flatMap((c) => c[1] as string[]);
const leads = () => db.collection("leads").docs;
const session = () => db.collection("sessions").docs[0];

describe("квалификация в WhatsApp", () => {
  it("первое сообщение: ответ клиенту, лида ещё нет; номер берётся из чата", async () => {
    llm.generate.mockResolvedValue(res("Здравствуйте! Какой этаж и площадь вас интересуют?"));
    const out = await handleInboundBatch(deps, [wa("Здравствуйте, интересует квартира")]);

    expect(out).toMatchObject({ kind: "replied", qualified: false, leadCreated: false, llmCalls: 1 });
    expect(sent()).toEqual(["Здравствуйте! Какой этаж и площадь вас интересуют?"]);
    expect(leads()).toHaveLength(0);
    expect(session().state).toMatchObject({ phone: "992931234567", userTurns: 1, name: "Алишер" });
  });

  it("цены подставляет код: в промпт попадает справка по названному этажу", async () => {
    llm.generate.mockResolvedValue(res("На 5 этаже рассрочка — $1 260 за м², полная оплата — $1 210. Как удобнее платить?"));
    await handleInboundBatch(deps, [wa("5 этаж, 45 м2")]);
    const system: string = llm.generate.mock.calls[0][0].system;
    expect(system).toContain("$1 260 за м²");
    expect(system).toContain("$1 210 за м²");
    expect(system).toContain("$56 700"); // рассрочка для 45 м²
    expect(system).toContain("СЛЕДУЮЩИЙ ШАГ: дай цифры по этажу");
  });

  it("клиент назвал этаж и оплату → лид создан, источник WhatsApp, диалог закрыт", async () => {
    llm.generate.mockResolvedValue(res("Отлично, всё записал.", { summary: "Хочет 5 этаж, рассрочка" }));
    const out = await handleInboundBatch(deps, [wa("5 этаж, 45 м2, рассрочка")]);

    expect(out).toMatchObject({ qualified: true, leadCreated: true });
    expect(leads()).toHaveLength(1);
    expect(leads()[0]).toMatchObject({
      phone: "992931234567",
      source: "WhatsApp",
      stage: "Новый лид",
      status: "pending",
      qualification: { floor: 5, areaSqm: 45, paymentType: "installment_50" },
      summary: "Хочет 5 этаж, рассрочка",
    });
    expect(sent().at(-1)).toContain("Передаю вашу заявку менеджеру");
    expect(session().handedOff).toBe(true);
  });

  it("после передачи менеджеру бот молчит", async () => {
    llm.generate.mockResolvedValue(res("ок"));
    await handleInboundBatch(deps, [wa("5 этаж, рассрочка")]);
    llm.generate.mockClear();
    sendBubbles.mockClear();
    expect(await handleInboundBatch(deps, [wa("а когда сдача?")])).toEqual({ kind: "ignored", reason: "handed_off" });
    expect(llm.generate).not.toHaveBeenCalled();
    expect(sendBubbles).not.toHaveBeenCalled();
  });

  it("модель узнала этаж, которого не поймали регулярки → ответ перегенерируется с верными цифрами", async () => {
    llm.generate
      .mockResolvedValueOnce(res("Какой этаж интересует?", { floor: 7 })) // ответ по старой справке
      .mockResolvedValueOnce(res("На 7 этаже: рассрочка — $1 220 за м², полная оплата — $1 170."));
    const out = await handleInboundBatch(deps, [wa("седьмой этаж пожалуйста")]);

    expect(out).toMatchObject({ llmCalls: 2, qualified: false });
    expect(llm.generate.mock.calls[1][0].system).toContain("$1 220 за м²");
    expect(sent()).toEqual(["На 7 этаже: рассрочка — $1 220 за м², полная оплата — $1 170."]);
    expect(session().state.floor).toBe(7);
  });

  it("этаж вне прайса не фиксируется, менеджер получает пометку", async () => {
    llm.generate.mockResolvedValue(res("Уточню у менеджера."));
    await handleInboundBatch(deps, [wa("есть 25 этаж?")]);
    expect(session().state.floor).toBeUndefined();
    expect(session().state.notes).toContain("этаж 25");
  });

  it("клиент просит менеджера → передача, даже без этажа и оплаты", async () => {
    llm.generate.mockResolvedValue(res("Конечно, передам менеджеру.", { wantsHuman: true, summary: "Просит менеджера" }));
    const out = await handleInboundBatch(deps, [wa("позовите менеджера")]);
    expect(out).toMatchObject({ qualified: true, leadCreated: true });
    expect(leads()[0].qualification.floor).toBeUndefined();
  });

  it("лимит реплик: после maxUserTurns с известным телефоном лид передаётся менеджеру", async () => {
    llm.generate.mockResolvedValue(res("Расскажите подробнее."));
    for (let i = 0; i < 3; i++) await handleInboundBatch(deps, [wa(`сообщение ${i}`)]);
    expect(leads()).toHaveLength(0);
    expect(await handleInboundBatch(deps, [wa("ещё одно")])).toMatchObject({ qualified: true });
    expect(leads()).toHaveLength(1);
  });

  it("телефон, названный клиентом явно, перекрывает номер чата", async () => {
    llm.generate.mockResolvedValue(res("ок"));
    await handleInboundBatch(deps, [wa("5 этаж, рассрочка, звоните на 93 777 66 55")]);
    expect(leads()[0].phone).toBe("992937776655");
  });

  it("если ответ модели заканчивается вопросом, при передаче он не отправляется", async () => {
    llm.generate.mockResolvedValue(res("Принято. Чем ещё помочь?"));
    await handleInboundBatch(deps, [wa("5 этаж, рассрочка")]);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("Передаю вашу заявку");
  });
});

describe("Instagram Direct (телефона из канала нет)", () => {
  it("пока номера нет — лид не создаётся; номер назван → передача менеджеру", async () => {
    llm.generate.mockResolvedValue(res("Оставьте, пожалуйста, номер телефона."));
    expect(await handleInboundBatch(deps, [ig("5 этаж, рассрочка")])).toMatchObject({ qualified: false });
    expect(leads()).toHaveLength(0);

    llm.generate.mockResolvedValue(res("Спасибо!"));
    expect(await handleInboundBatch(deps, [ig("мой номер 93 123 45 67")])).toMatchObject({ qualified: true, leadCreated: true });
    expect(leads()[0]).toMatchObject({ phone: "992931234567", source: "Таргет Instagram", channel: "instagram" });
  });
});

describe("устойчивость", () => {
  it("ИИ недоступен, телефон известен (WhatsApp): лид не теряется, клиент получает ответ", async () => {
    llm.generate.mockRejectedValue(new LlmUnavailableError("down"));
    const out = await handleInboundBatch(deps, [wa("Здравствуйте")]);
    expect(out).toMatchObject({ qualified: true, leadCreated: true, usedFallback: true });
    expect(leads()[0].summary).toContain("ИИ был недоступен");
    expect(sent().at(-1)).toContain("Передаю вашу заявку");
  });

  it("ИИ недоступен, телефона нет (Instagram): просим номер, лида нет", async () => {
    llm.generate.mockRejectedValue(new LlmUnavailableError("down"));
    const out = await handleInboundBatch(deps, [ig("Здравствуйте")]);
    expect(out).toMatchObject({ qualified: false, usedFallback: true });
    expect(sent()[0]).toMatch(/номер телефона/);
    expect(leads()).toHaveLength(0);
  });

  it("сбой отправки ответа не теряет состояние диалога", async () => {
    llm.generate.mockResolvedValue(res("Какой этаж?"));
    sendBubbles.mockRejectedValue(new Error("Evolution 500"));
    const out = await handleInboundBatch(deps, [wa("Здравствуйте")]);
    expect(out).toMatchObject({ kind: "replied" });
    expect(session().state.userTurns).toBe(1);
    expect(db.collection("failed_events").docs[0]).toMatchObject({ kind: "send_reply" });
  });

  it("повторное обращение известного клиента не плодит лиды", async () => {
    await createLeadIfNew({ name: "Алишер", phone: "992931234567", source: "Таргет Facebook", channel: "meta_form" });
    llm.generate.mockResolvedValue(res("ок"));
    const out = await handleInboundBatch(deps, [wa("5 этаж, рассрочка")]);
    expect(out).toMatchObject({ qualified: true, leadCreated: false });
    expect(leads()).toHaveLength(1);
    expect(leads()[0].contactCount).toBe(2);
  });
});

describe("isQualified", () => {
  it("нужны телефон, этаж и способ оплаты (площадь необязательна)", () => {
    expect(isQualified({ userTurns: 1, phone: "1", floor: 5, paymentType: "full_100" })).toBe(true);
    expect(isQualified({ userTurns: 1, phone: "1", floor: 5 })).toBe(false);
    expect(isQualified({ userTurns: 1, floor: 5, paymentType: "full_100" })).toBe(false);
    expect(isQualified({ userTurns: 1, phone: "1", paymentType: "full_100" })).toBe(false);
  });
});
