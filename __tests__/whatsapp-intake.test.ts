import { isEvolutionAuthorized, parseEvolutionMessage, processEvolutionEvent } from "@/lib/services/whatsapp-intake";

const evt = (data: Record<string, unknown>, event = "messages.upsert") => ({ event, instance: "sunrise", data });
const key = (over: Record<string, unknown> = {}) => ({ id: "MSG1", remoteJid: "992931234567@s.whatsapp.net", fromMe: false, ...over });

describe("parseEvolutionMessage", () => {
  it("обычный текст: контакт определяется по номеру, имя берётся из pushName", () => {
    const r = parseEvolutionMessage(evt({ key: key(), pushName: "Алишер", message: { conversation: "Здравствуйте" } }));
    expect(r).toMatchObject({ kind: "message", id: "MSG1", contactId: "992931234567", replyTo: "992931234567", phone: "992931234567", name: "Алишер", text: "Здравствуйте", hasAudio: false });
  });

  it("текст из extendedTextMessage и подпись к фото; data допустим массивом; имя события в верхнем регистре", () => {
    expect(parseEvolutionMessage(evt({ key: key(), message: { extendedTextMessage: { text: "5 этаж" } } }))).toMatchObject({ text: "5 этаж" });
    expect(parseEvolutionMessage(evt({ key: key(), message: { imageMessage: { caption: "вот планировка" } } }))).toMatchObject({ text: "вот планировка" });
    expect(parseEvolutionMessage({ event: "MESSAGES_UPSERT", data: [{ key: key(), message: { conversation: "привет" } }] })).toMatchObject({ kind: "message", text: "привет" });
  });

  it("скрытый идентификатор @lid: номер берётся из remoteJidAlt, без него отвечаем на lid", () => {
    const withAlt = parseEvolutionMessage(evt({ key: key({ remoteJid: "123456789@lid", remoteJidAlt: "992937776655@s.whatsapp.net" }), message: { conversation: "hi" } }));
    expect(withAlt).toMatchObject({ phone: "992937776655", contactId: "992937776655" });

    const noAlt = parseEvolutionMessage(evt({ key: key({ remoteJid: "123456789@lid" }), message: { conversation: "hi" } }));
    expect(noAlt).toMatchObject({ kind: "message", replyTo: "123456789@lid" });
    expect((noAlt as { phone?: string }).phone).toBeUndefined();
  });

  it("голосовое сообщение — hasAudio, текста нет", () => {
    expect(parseEvolutionMessage(evt({ key: key(), message: { audioMessage: { seconds: 5 } } }))).toMatchObject({ kind: "message", hasAudio: true, text: "" });
  });

  it.each([
    ["свои исходящие", evt({ key: key({ fromMe: true }), message: { conversation: "x" } })],
    ["группа", evt({ key: key({ remoteJid: "120363000000000000@g.us" }), message: { conversation: "x" } })],
    ["статус-канал", evt({ key: key({ remoteJid: "status@broadcast" }), message: { conversation: "x" } })],
    ["фото без подписи", evt({ key: key(), message: { imageMessage: {} } })],
    ["нет id", evt({ key: { remoteJid: "992931234567@s.whatsapp.net" }, message: { conversation: "x" } })],
    ["другое событие", evt({ key: key(), message: { conversation: "x" } }, "connection.update")],
    ["нет данных", { event: "messages.upsert" }],
  ])("игнорирует: %s", (_name, body) => expect(parseEvolutionMessage(body).kind).toBe("ignore"));

  it("мусор на входе не падает", () => {
    for (const bad of [null, undefined, "x", 5, [], {}]) expect(parseEvolutionMessage(bad).kind).toBe("ignore");
  });
});

describe("isEvolutionAuthorized", () => {
  const base = { production: true };
  it("общий секрет: заголовок или параметр URL; неверный — отказ", () => {
    expect(isEvolutionAuthorized({ ...base, webhookSecret: "s3", headerSecret: "s3" })).toBe(true);
    expect(isEvolutionAuthorized({ ...base, webhookSecret: "s3", querySecret: "s3" })).toBe(true);
    expect(isEvolutionAuthorized({ ...base, webhookSecret: "s3", headerSecret: "bad" })).toBe(false);
    expect(isEvolutionAuthorized({ ...base, webhookSecret: "s3" })).toBe(false);
  });
  it("запасной вариант — apikey инстанса в теле; секрет имеет приоритет", () => {
    expect(isEvolutionAuthorized({ ...base, apiKey: "K", bodyApiKey: "K" })).toBe(true);
    expect(isEvolutionAuthorized({ ...base, apiKey: "K", bodyApiKey: "X" })).toBe(false);
    expect(isEvolutionAuthorized({ ...base, webhookSecret: "s3", apiKey: "K", bodyApiKey: "K" })).toBe(false);
  });
  it("без настроенных секретов принимается только вне production", () => {
    expect(isEvolutionAuthorized({ production: true })).toBe(false);
    expect(isEvolutionAuthorized({ production: false })).toBe(true);
  });
});

describe("processEvolutionEvent", () => {
  const make = (over: Partial<Parameters<typeof processEvolutionEvent>[1]> = {}) => {
    const push = jest.fn();
    return {
      push,
      deps: {
        batcher: { push },
        claimEvent: jest.fn(async () => true),
        supportsAudio: true,
        fetchAudio: jest.fn(async () => ({ base64: "QUJD", mimetype: "audio/ogg; codecs=opus" })),
        ...over,
      },
    };
  };
  const text = evt({ key: key(), pushName: "Алишер", message: { conversation: "5 этаж" } });

  it("ставит сообщение в очередь склейки с ключом канала и контакта", async () => {
    const { push, deps } = make();
    expect(await processEvolutionEvent(text, deps)).toBe("queued");
    expect(deps.claimEvent).toHaveBeenCalledWith("wa:MSG1");
    expect(push).toHaveBeenCalledWith("whatsapp:992931234567", expect.objectContaining({ channel: "whatsapp", contactId: "992931234567", phone: "992931234567", name: "Алишер", text: "5 этаж", readKeys: [{ id: "MSG1", remoteJid: "992931234567@s.whatsapp.net" }] }));
  });

  it("повтор доставки того же сообщения не обрабатывается; лишние события игнорируются", async () => {
    const dup = make({ claimEvent: jest.fn(async () => false) });
    expect(await processEvolutionEvent(text, dup.deps)).toBe("duplicate");
    expect(dup.push).not.toHaveBeenCalled();

    const ign = make();
    expect(await processEvolutionEvent(evt({ key: key({ fromMe: true }), message: { conversation: "x" } }), ign.deps)).toBe("ignored");
    expect(ign.deps.claimEvent).not.toHaveBeenCalled();
  });

  it("голосовое: аудио передаётся модели; при сбое скачивания или без поддержки — текстовая пометка", async () => {
    const voice = evt({ key: key({ id: "V1" }), message: { audioMessage: {} } });

    const ok = make();
    await processEvolutionEvent(voice, ok.deps);
    expect(ok.push.mock.calls[0][1]).toMatchObject({ text: "", audio: { base64: "QUJD", mimeType: "audio/ogg; codecs=opus" } });

    const broken = make({ fetchAudio: jest.fn(async () => { throw new Error("404"); }) });
    await processEvolutionEvent(voice, broken.deps);
    expect(broken.push.mock.calls[0][1].text).toContain("голосовое сообщение");
    expect(broken.push.mock.calls[0][1].audio).toBeUndefined();

    const noAudio = make({ supportsAudio: false });
    await processEvolutionEvent(voice, noAudio.deps);
    expect(noAudio.deps.fetchAudio).not.toHaveBeenCalled();
    expect(noAudio.push.mock.calls[0][1].text).toBe("[голосовое сообщение]");
  });
});
