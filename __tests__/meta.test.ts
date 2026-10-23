import { createHmac } from "node:crypto";
import { resetConfigCache } from "@/lib/config";
import { getDb } from "@/lib/mongodb";
import { fetchLeadgen, mapLeadFields, parseMetaPayload, resolveChallenge, sendInstagramText, verifyMetaSignature } from "@/lib/integrations/meta";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

const noSleep = { sleep: async () => undefined };

beforeEach(() => {
  Object.assign(process.env, { META_APP_SECRET: "app-secret", META_VERIFY_TOKEN: "vt", META_PAGE_ACCESS_TOKEN: "PAGE_TOKEN", META_GRAPH_VERSION: "v23.0" });
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_APP_SECRET;
  delete process.env.INSTAGRAM_USER_ID;
  (getDb as jest.Mock).mockResolvedValue(new FakeDb());
  resetConfigCache();
});
afterEach(() => jest.restoreAllMocks());

const sign = (body: string, secret = "app-secret") => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("подпись вебхука", () => {
  const body = '{"object":"page","entry":[]}';
  it("принимает верную подпись", () => expect(verifyMetaSignature(body, sign(body), "app-secret")).toBe(true));
  it("отклоняет чужой секрет, изменённое тело, мусор и отсутствие заголовка", () => {
    expect(verifyMetaSignature(body, sign(body, "other"), "app-secret")).toBe(false);
    expect(verifyMetaSignature(body + " ", sign(body), "app-secret")).toBe(false);
    expect(verifyMetaSignature(body, "sha256=abc", "app-secret")).toBe(false);
    expect(verifyMetaSignature(body, "abc", "app-secret")).toBe(false);
    expect(verifyMetaSignature(body, null, "app-secret")).toBe(false);
  });
  it("несколько секретов (основное приложение и приложение Instagram): подходит любой", () => {
    const secrets = ["app-secret", "ig-secret"];
    expect(verifyMetaSignature(body, sign(body, "app-secret"), secrets)).toBe(true);
    expect(verifyMetaSignature(body, sign(body, "ig-secret"), secrets)).toBe(true);
    expect(verifyMetaSignature(body, sign(body, "third"), secrets)).toBe(false);
    expect(verifyMetaSignature(body, sign(body, "app-secret"), [])).toBe(false);
    expect(verifyMetaSignature(body, sign(body, ""), [""])).toBe(false); // пустой секрет не считается секретом
  });
  it("рукопожатие GET: отдаёт challenge только при верном токене", () => {
    const ok = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "123" });
    expect(resolveChallenge(ok, "vt")).toBe("123");
    expect(resolveChallenge(ok, "wrong")).toBeNull();
    expect(resolveChallenge(new URLSearchParams({ "hub.mode": "unsubscribe", "hub.verify_token": "vt", "hub.challenge": "1" }), "vt")).toBeNull();
  });
});

describe("parseMetaPayload", () => {
  it("лид-форма: leadgen_id из changes", () => {
    const p = parseMetaPayload({
      object: "page",
      entry: [{ id: "P1", changes: [{ field: "leadgen", value: { leadgen_id: 444, page_id: "P1", form_id: 9 } }, { field: "feed", value: {} }] }],
    });
    expect(p.leadgens).toEqual([{ leadgenId: "444", pageId: "P1", formId: "9" }]);
    expect(p.messages).toEqual([]);
  });

  it("Instagram Direct: сообщения и эхо собственных ответов", () => {
    const p = parseMetaPayload({
      object: "instagram",
      entry: [{ messaging: [{ sender: { id: "U1" }, message: { mid: "m1", text: "Здравствуйте" } }, { sender: { id: "PAGE" }, message: { mid: "m2", text: "ответ", is_echo: true } }, { sender: { id: "U1" }, message: { text: "без mid" } }] }],
    });
    expect(p.messages).toEqual([
      { mid: "m1", senderId: "U1", text: "Здравствуйте", isEcho: false },
      { mid: "m2", senderId: "PAGE", text: "ответ", isEcho: true },
    ]);
  });

  it("сообщение от самого аккаунта (ответ менеджера из приложения Instagram) не считается клиентским", () => {
    const p = parseMetaPayload({
      object: "instagram",
      entry: [{ id: "IG_ACC", messaging: [{ sender: { id: "IG_ACC" }, recipient: { id: "U1" }, message: { mid: "m1", text: "ответ менеджера" } }, { sender: { id: "U1" }, recipient: { id: "IG_ACC" }, message: { mid: "m2", text: "вопрос клиента" } }] }],
    });
    expect(p.messages).toEqual([{ mid: "m2", senderId: "U1", text: "вопрос клиента", isEcho: false }]);
  });

  it("мусор не ломает разбор", () => {
    for (const bad of [null, "x", 5, {}, { entry: "no" }, { entry: [null, 1] }]) expect(parseMetaPayload(bad)).toEqual({ leadgens: [], messages: [] });
  });
});

describe("mapLeadFields", () => {
  it("Instagram-форма: имя, телефон, остальное в заметки", () => {
    const m = mapLeadFields({ id: "1", platform: "ig", fields: { full_name: "Алишер К.", phone_number: "+992 93 123 45 67", email: "a@b.tj", "какой_этаж?": "5" } });
    expect(m).toMatchObject({ name: "Алишер К.", phone: "+992 93 123 45 67", source: "Таргет Instagram" });
    expect(m.notes).toContain("email: a@b.tj");
    expect(m.notes).toContain("какой этаж?: 5");
  });
  it("Facebook по умолчанию; имя из first_name + last_name; телефона нет", () => {
    const m = mapLeadFields({ id: "2", platform: "fb", fields: { first_name: "Алишер", last_name: "Каримов" } });
    expect(m).toMatchObject({ name: "Алишер Каримов", phone: null, source: "Таргет Facebook" });
    expect(mapLeadFields({ id: "3", fields: {} })).toMatchObject({ name: "Без имени", source: "Таргет Facebook" });
  });
});

describe("Graph API", () => {
  it("fetchLeadgen: запрос с версией, токеном и разбор field_data", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes(200, { id: "444", platform: "ig", field_data: [{ name: "full_name", values: ["Алишер"] }, { name: "phone_number", values: ["+992931234567"] }] })
    );
    const lead = await fetchLeadgen("444", noSleep);
    expect(lead).toEqual({ id: "444", platform: "ig", fields: { full_name: "Алишер", phone_number: "+992931234567" } });
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("graph.facebook.com/v23.0/444");
    expect(url).toContain("access_token=PAGE_TOKEN");
  });

  it("повторяет при 500 и сдаётся с понятной ошибкой при 400", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonRes(500, {})).mockResolvedValueOnce(jsonRes(200, { id: "1", field_data: [] }));
    await expect(fetchLeadgen("1", noSleep)).resolves.toMatchObject({ id: "1" });
    expect(spy).toHaveBeenCalledTimes(2);

    jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes(400, { error: { message: "Invalid token" } }));
    await expect(fetchLeadgen("1", noSleep)).rejects.toThrow(/вернул 400.*Invalid token/);
  });

  it("sendInstagramText: тело запроса и ошибка при отказе", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes(200, {}));
    await sendInstagramText("U1", "Привет", noSleep);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/v23.0/me/messages");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ recipient: { id: "U1" }, message: { text: "Привет" } });

    jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes(403, { error: "window closed" }));
    await expect(sendInstagramText("U1", "Привет", noSleep)).rejects.toThrow(/403/);
  });

  it("Instagram Login: graph.instagram.com, токен в заголовке Authorization, а не в адресе", async () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = "IGAA_TOKEN";
    resetConfigCache();
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes(200, {}));
    await sendInstagramText("U1", "Привет", noSleep);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe("https://graph.instagram.com/v23.0/me/messages");
    expect(String(url)).not.toContain("IGAA_TOKEN");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer IGAA_TOKEN" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ recipient: { id: "U1" }, message: { text: "Привет" } });
  });

  it("Instagram Login: INSTAGRAM_USER_ID заменяет «me»; токен Instagram приоритетнее токена страницы", async () => {
    Object.assign(process.env, { INSTAGRAM_ACCESS_TOKEN: "IGAA_TOKEN", INSTAGRAM_USER_ID: "1784" });
    resetConfigCache();
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes(200, {}));
    await sendInstagramText("U1", "Привет", noSleep);
    expect(String(spy.mock.calls[0][0])).toBe("https://graph.instagram.com/v23.0/1784/messages");
  });

  it("без каких-либо токенов — понятная ошибка, запрос не отправляется", async () => {
    delete process.env.META_PAGE_ACCESS_TOKEN;
    resetConfigCache();
    const spy = jest.spyOn(globalThis, "fetch");
    await expect(sendInstagramText("U1", "Привет", noSleep)).rejects.toThrow(/INSTAGRAM_ACCESS_TOKEN/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("лид-формы без токена страницы: понятная ошибка вместо запроса с пустым токеном", async () => {
    delete process.env.META_PAGE_ACCESS_TOKEN;
    resetConfigCache();
    await expect(fetchLeadgen("1", noSleep)).rejects.toThrow(/META_PAGE_ACCESS_TOKEN/);
  });
});
