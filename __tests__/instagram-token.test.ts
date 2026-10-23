import { resetConfigCache } from "@/lib/config";
import { getDb } from "@/lib/mongodb";
import { getInstagramToken, refreshInstagramTokenIfDue } from "@/lib/integrations/instagram-token";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

const noSleep = { sleep: async () => undefined };
const DAY = 24 * 3_600_000;
const T0 = new Date("2026-10-23T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let db: FakeDb;
const record = () => db.collection("credentials").docs[0];

beforeEach(() => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  Object.assign(process.env, { META_APP_SECRET: "s", META_VERIFY_TOKEN: "vt", INSTAGRAM_ACCESS_TOKEN: "IGAA_SEED" });
  delete process.env.META_PAGE_ACCESS_TOKEN;
  resetConfigCache();
});
afterEach(() => jest.restoreAllMocks());

describe("токен Instagram Login", () => {
  it("без INSTAGRAM_ACCESS_TOKEN ничего не делает", async () => {
    delete process.env.INSTAGRAM_ACCESS_TOKEN;
    resetConfigCache();
    expect(await getInstagramToken()).toBeUndefined();
    expect(await refreshInstagramTokenIfDue(T0, noSleep)).toBe("not_configured");
  });

  it("первый запуск запоминает токен как свежий и не обращается к Meta", async () => {
    const spy = jest.spyOn(globalThis, "fetch");
    expect(await refreshInstagramTokenIfDue(T0, noSleep)).toBe("fresh");
    expect(await refreshInstagramTokenIfDue(at(3 * DAY), noSleep)).toBe("fresh");
    expect(spy).not.toHaveBeenCalled();
    expect(await getInstagramToken()).toBe("IGAA_SEED");
  });

  it("через неделю продлевает: новый токен сохраняется в БД и используется дальше", async () => {
    await refreshInstagramTokenIfDue(T0, noSleep);
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes(200, { access_token: "IGAA_NEW", token_type: "bearer", expires_in: 5_184_000 }));

    expect(await refreshInstagramTokenIfDue(at(8 * DAY), noSleep)).toBe("refreshed");

    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(url.searchParams.get("access_token")).toBe("IGAA_SEED");
    expect(record()).toMatchObject({ token: "IGAA_NEW", obtainedAt: at(8 * DAY), expiresAt: at(8 * DAY + 60 * DAY) });
    expect(await getInstagramToken()).toBe("IGAA_NEW");

    // и снова «свежий» — повторного запроса нет
    expect(await refreshInstagramTokenIfDue(at(9 * DAY), noSleep)).toBe("fresh");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("сбой продления: старый токен остаётся, ошибка записана, повтор не чаще раза в 6 часов", async () => {
    await refreshInstagramTokenIfDue(T0, noSleep);
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes(400, { error: { message: "Session has expired" } }));
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await refreshInstagramTokenIfDue(at(8 * DAY), noSleep)).toBe("failed");
    expect(record().lastError).toContain("Session has expired");
    expect(await getInstagramToken()).toBe("IGAA_SEED");

    expect(await refreshInstagramTokenIfDue(at(8 * DAY + 3_600_000), noSleep)).toBe("backoff");
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockResolvedValue(jsonRes(200, { access_token: "IGAA_OK", expires_in: 5_184_000 }));
    expect(await refreshInstagramTokenIfDue(at(8 * DAY + 7 * 3_600_000), noSleep)).toBe("refreshed");
    expect(record().lastError).toBeUndefined();
    expect(await getInstagramToken()).toBe("IGAA_OK");
  });

  it("токен в переменной окружения заменили вручную — продлённый из БД больше не используется", async () => {
    await refreshInstagramTokenIfDue(T0, noSleep);
    jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes(200, { access_token: "IGAA_NEW", expires_in: 5_184_000 }));
    await refreshInstagramTokenIfDue(at(8 * DAY), noSleep);
    expect(await getInstagramToken()).toBe("IGAA_NEW");

    process.env.INSTAGRAM_ACCESS_TOKEN = "IGAA_MANUAL";
    resetConfigCache();
    expect(await getInstagramToken()).toBe("IGAA_MANUAL");
    expect(await refreshInstagramTokenIfDue(at(9 * DAY), noSleep)).toBe("fresh"); // отсчёт начат заново
    expect(record()).toMatchObject({ token: "IGAA_MANUAL", obtainedAt: at(9 * DAY) });
  });

  it("MongoDB недоступна — отправка не падает, берётся токен из окружения", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    (getDb as jest.Mock).mockRejectedValue(new Error("mongo down"));
    expect(await getInstagramToken()).toBe("IGAA_SEED");
  });
});
