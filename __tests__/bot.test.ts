/* eslint-disable @typescript-eslint/no-explicit-any */
import { Bot } from "grammy";
import { getDb } from "@/lib/mongodb";
import { resetIndexCacheForTests } from "@/lib/db/collections";
import { getActiveManager, upsertManager } from "@/lib/db/managers";
import { registerLead, type PipelineDeps } from "@/lib/services/lead-pipeline";
import { ADD_CLIENT_BUTTON, registerHandlers } from "@/lib/telegram/bot";
import type { TelegramGateway } from "@/lib/telegram/gateway";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

const ADMIN = 9000;
const ALISA = 1;
const BOBO = 2;
const GROUP = -1001;

let db: FakeDb;
let calls: { method: string; payload: any }[];
let gateway: jest.Mocked<TelegramGateway>;
let syncSheet: jest.Mock;
let bot: Bot;
let pipeline: PipelineDeps;
let uid: number;
let msgId: number;

function build(manualAssign: "self" | "pool" = "self") {
  bot = new Bot("123456:TEST", {
    botInfo: { id: 123456, is_bot: true, first_name: "Sunrise", username: "sunrise_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never,
  });
  // перехват всех вызовов Telegram API
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const result = method === "sendMessage" || method === "editMessageText" ? { message_id: ++msgId, date: 0, chat: { id: (payload as any).chat_id, type: "private" } } : true;
    return { ok: true, result } as never;
  });
  gateway = {
    sendCard: jest.fn(async () => ({ chatId: GROUP, messageId: ++msgId })),
    markClaimed: jest.fn(async () => undefined),
    sendDm: jest.fn(async () => true),
    sendGroupHtml: jest.fn(async () => undefined),
    sendTo: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<TelegramGateway>;
  syncSheet = jest.fn(async () => undefined);
  pipeline = { gateway, syncSheet, adminIds: [ADMIN], escalationMinutes: 15 };
  registerHandlers(bot, { pipeline, manualAssign, sendReportTo: jest.fn(async () => undefined) });
}

beforeEach(async () => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  resetIndexCacheForTests();
  calls = [];
  uid = 1000;
  msgId = 500;
  build();
  await upsertManager({ telegramId: ALISA, name: "Алиса", sheetName: "Менеджер 1" });
  await upsertManager({ telegramId: BOBO, name: "Бобо", sheetName: "Менеджер 2" });
});

const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });
const send = (from: number, text: string, chat: { id: number; type: string } = { id: from, type: "private" }) => {
  const cmd = text.startsWith("/") ? text.split(" ")[0] : null;
  return bot.handleUpdate({
    update_id: ++uid,
    message: { message_id: ++msgId, date: 0, chat, from: user(from), text, ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd.length }] } : {}) },
  } as never);
};
const press = (from: number, data: string, chatId = from) =>
  bot.handleUpdate({
    update_id: ++uid,
    callback_query: { id: String(uid), from: user(from), chat_instance: "ci", data, message: { message_id: 100, date: 0, chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" } } },
  } as never);

const replies = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
const lastReply = () => replies().at(-1) ?? "";
const answers = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload);
const leads = () => db.collection("leads").docs;

describe("служебные команды", () => {
  it("/start для неподключённого — показывает его Telegram ID; руководителю — ещё и список команд", async () => {
    await send(777, "/start");
    expect(lastReply()).toContain("Ваш Telegram ID: 777");

    calls = [];
    await send(ADMIN, "/start");
    expect(replies()[0]).toContain(`Ваш Telegram ID: ${ADMIN}`);
    expect(lastReply()).toContain("/addmanager");
  });

  it("/start для менеджера — приветствие, лист и постоянная кнопка ручного ввода", async () => {
    await send(ALISA, "/start");
    expect(lastReply()).toContain("Алиса");
    expect(lastReply()).toContain("Менеджер 1");
    expect(JSON.stringify(calls.find((c) => c.method === "sendMessage")?.payload.reply_markup)).toContain(ADD_CLIENT_BUTTON);
  });

  it("/addmanager: только руководитель, проверка формата и занятого листа", async () => {
    await send(777, "/addmanager 555555 Менеджер 3 Вали");
    expect(replies()).toHaveLength(0); // чужим не отвечаем
    expect(await getActiveManager(555555)).toBeNull();

    await send(ADMIN, "/addmanager 555555 менеджер 3 Вали Рахимов");
    expect(lastReply()).toContain("Подключён: Вали Рахимов → лист «Менеджер 3»");
    expect((await getActiveManager(555555))?.sheetName).toBe("Менеджер 3");

    await send(ADMIN, "/addmanager 666666 Менеджер 1 Другой");
    expect(lastReply()).toContain("уже занят");
    await send(ADMIN, "/addmanager привет");
    expect(lastReply()).toContain("Формат:");
  });

  it("/managers и /removemanager", async () => {
    await send(ADMIN, "/managers");
    expect(lastReply()).toContain("Менеджер 1: Алиса");
    expect(lastReply()).toContain("Менеджер 2: Бобо");
    await send(ADMIN, `/removemanager ${BOBO}`);
    expect(lastReply()).toBe("Менеджер отключён.");
    expect(await getActiveManager(BOBO)).toBeNull();
    await send(ADMIN, `/removemanager ${BOBO}`);
    expect(lastReply()).toContain("не найден");
  });
});

describe("ручной ввод клиента (➕ Добавить клиента)", () => {
  async function fillFlow(from: number, note: string | null) {
    await send(from, ADD_CLIENT_BUTTON);
    await send(from, "Алишер Каримов");
    await send(from, "+992 93 123 45 67");
    await press(from, "flow:src:1"); // Somon.tj
    if (note === null) await press(from, "flow:skip");
    else await send(from, note);
  }

  it("пошаговый диалог создаёт лид, закреплённый за менеджером, и запускает запись в таблицу", async () => {
    await send(ALISA, ADD_CLIENT_BUTTON);
    expect(lastReply()).toBe("Как зовут клиента?");
    await send(ALISA, "Алишер Каримов");
    expect(lastReply()).toContain("Номер телефона");
    await send(ALISA, "это не номер");
    expect(lastReply()).toContain("Не похоже на номер");
    await send(ALISA, "+992 93 123 45 67");
    expect(lastReply()).toBe("Откуда клиент?");
    await press(ALISA, "flow:src:1");
    expect(lastReply()).toContain("Источник: Somon.tj");
    await send(ALISA, "интересует 5 этаж, рассрочка");

    expect(lastReply()).toContain("закреплён за вами");
    expect(lastReply()).toContain("Менеджер 1");
    expect(leads()).toHaveLength(1);
    expect(leads()[0]).toMatchObject({
      name: "Алишер Каримов",
      phone: "992931234567",
      source: "Somon.tj",
      channel: "manual",
      stage: "Новый лид",
      status: "claimed",
      claim: { managerId: ALISA, managerName: "Алиса", sheetName: "Менеджер 1" },
      summary: "интересует 5 этаж, рассрочка",
    });
    expect(syncSheet).toHaveBeenCalledTimes(1);
    expect(gateway.sendCard).not.toHaveBeenCalled();
    expect(db.collection("tg_flows").docs).toHaveLength(0);
  });

  it("«Пропустить» комментарий; повторный ввод того же телефона — сообщение о дубликате без новой записи", async () => {
    await fillFlow(ALISA, null);
    expect(leads()).toHaveLength(1);
    expect(leads()[0].summary).toBeUndefined();

    await fillFlow(BOBO, null);
    expect(lastReply()).toContain("уже в базе");
    expect(lastReply()).toContain("закреплён за Алиса");
    expect(leads()).toHaveLength(1);
  });

  it("режим pool: лид уходит в общую группу как обычный", async () => {
    build("pool");
    await fillFlow(ALISA, "позвонил по баннеру");
    expect(lastReply()).toContain("отправлен в общую группу");
    expect(leads()[0].status).toBe("pending");
    expect(gateway.sendCard).toHaveBeenCalledTimes(1);
    expect(syncSheet).not.toHaveBeenCalled();
  });

  it("отмена на любом шаге очищает диалог; после этого текст не воспринимается как шаг", async () => {
    await send(ALISA, ADD_CLIENT_BUTTON);
    await send(ALISA, "Алишер");
    await press(ALISA, "flow:cancel");
    expect(lastReply()).toBe("Отменено.");
    expect(db.collection("tg_flows").docs).toHaveLength(0);

    calls = [];
    await send(ALISA, "+992 93 123 45 67");
    expect(replies()).toHaveLength(0);
    expect(leads()).toHaveLength(0);
  });

  it("неподключённый пользователь не может начать диалог; в группе кнопка не работает", async () => {
    await send(777, ADD_CLIENT_BUTTON);
    expect(lastReply()).toContain("подключит");
    expect(db.collection("tg_flows").docs).toHaveLength(0);

    calls = [];
    await send(ALISA, ADD_CLIENT_BUTTON, { id: GROUP, type: "supergroup" });
    expect(replies()).toHaveLength(0);
  });

  it("устаревшая кнопка источника и слишком короткое имя", async () => {
    await press(ALISA, "flow:src:0");
    expect(answers().at(-1)).toMatchObject({ show_alert: true });
    await send(ALISA, ADD_CLIENT_BUTTON);
    await send(ALISA, "А");
    expect(lastReply()).toContain("Введите имя");
  });
});

describe("клик 🦈 в группе", () => {
  async function newLead() {
    const r = await registerLead(pipeline, { name: "Алишер", phone: "+992 93 123 45 67", source: "Таргет Instagram", channel: "meta_form" });
    return r.lead._id.toHexString();
  }

  it("победитель получает подтверждение, второй — отказ с именем победителя", async () => {
    const id = await newLead();
    await press(ALISA, `claim:${id}`, GROUP);
    expect(answers().at(-1)).toMatchObject({ text: expect.stringContaining("Лид ваш") });
    expect(answers().at(-1).show_alert).toBeUndefined();

    await press(BOBO, `claim:${id}`, GROUP);
    expect(answers().at(-1)).toMatchObject({ text: "Уже забрал: Алиса", show_alert: true });
    expect(leads()[0].claim.managerName).toBe("Алиса");
  });

  it("если личка недоступна — контакт показывается во всплывающем окне", async () => {
    gateway.sendDm.mockResolvedValue(false);
    const id = await newLead();
    await press(ALISA, `claim:${id}`, GROUP);
    expect(answers().at(-1)).toMatchObject({ show_alert: true, text: expect.stringContaining("+992 93 123 45 67") });
  });

  it("не менеджер, несуществующий лид, нажатие на «✅ Забрал»", async () => {
    const id = await newLead();
    await press(777, `claim:${id}`, GROUP);
    expect(answers().at(-1).text).toContain("не подключены");
    expect(leads()[0].status).toBe("pending");

    await press(ALISA, "claim:64b64b64b64b64b64b64b64b", GROUP);
    expect(answers().at(-1).text).toBe("Лид не найден");

    await press(ALISA, "noop", GROUP);
    expect(answers().at(-1).text).toContain("уже закреплён");
  });
});

describe("недоступная БД и ошибки обработчика (режим вебхука)", () => {
  const dbDown = () => (getDb as jest.Mock).mockRejectedValue(new Error("connect ECONNREFUSED"));

  it("/whoami отвечает даже при полностью недоступной БД (раньше бот молчал, а вебхук отдавал 500)", async () => {
    dbDown();
    await expect(send(777, "/whoami")).resolves.toBeUndefined();
    expect(lastReply()).toContain("Ваш Telegram ID: 777");
  });

  it("/start при недоступной БД сообщает ID и предупреждает о БД", async () => {
    dbDown();
    await send(777, "/start");
    expect(lastReply()).toContain("Ваш Telegram ID: 777");
    expect(lastReply()).toContain("База данных сейчас недоступна");
  });

  it("ошибка в обработчике не вылетает из handleUpdate; пользователь видит сообщение вместо тишины", async () => {
    // дедупликация (первое обращение к БД) проходит, а сама команда руководителя падает на БД
    const original = (getDb as jest.Mock).getMockImplementation();
    let calls = 0;
    (getDb as jest.Mock).mockImplementation(async () => {
      if (++calls > 1) throw new Error("mongo went away");
      return db;
    });
    await expect(send(ADMIN, "/managers")).resolves.toBeUndefined();
    expect(lastReply()).toContain("Внутренняя ошибка сервера");
    if (original) (getDb as jest.Mock).mockImplementation(original);
  });

  it("при ошибке в нажатии кнопки пользователь получает всплывающее предупреждение", async () => {
    dbDown();
    await expect(press(ALISA, "claim:64b64b64b64b64b64b64b64b", GROUP)).resolves.toBeUndefined();
    expect(answers().at(-1)).toMatchObject({ show_alert: true, text: expect.stringContaining("Ошибка сервера") });
  });
});

describe("надёжность", () => {
  it("повторная доставка того же обновления обрабатывается один раз", async () => {
    const update = { update_id: 4242, message: { message_id: 1, date: 0, chat: { id: 777, type: "private" }, from: user(777), text: "/whoami", entities: [{ type: "bot_command", offset: 0, length: 7 }] } };
    await bot.handleUpdate(update as never);
    await bot.handleUpdate(update as never);
    expect(replies()).toHaveLength(1);
  });
});
