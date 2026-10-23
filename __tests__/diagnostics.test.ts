import { configProblems, explainMongoError, explainWebhook, sanitize } from "@/lib/services/diagnostics";

const NOW = Date.parse("2026-10-23T07:30:00Z");
const URL_OK = "https://sunrise-gwy8.onrender.com/api/telegram-webhook";
const ago = (min: number) => Math.round((NOW - min * 60_000) / 1000);

describe("sanitize", () => {
  it("вычищает пароль из строки подключения и токен бота", () => {
    expect(sanitize("connect mongodb+srv://sunrise:Secr3t@cluster0.x.mongodb.net/db failed")).toBe("connect mongodb+srv://***@cluster0.x.mongodb.net/db failed");
    expect(sanitize("GET /bot8789709549:AAE4QgLxOTRHpwdWyKLngYabc/getMe")).toContain("bot***");
    expect(sanitize("token ABC123 leaked", ["ABC123"])).toBe("token *** leaked");
  });
});

describe("explainMongoError", () => {
  it.each([
    ["MONGODB_URI не задан — см. .env.example", /MONGODB_URI не задана/],
    ["bad auth : Authentication failed.", /неверное имя пользователя или пароль/],
    ["querySrv ENOTFOUND _mongodb._tcp.cluster0.xxxx.mongodb.net", /адрес кластера/],
    ["Server selection timed out after 5000 ms", /Network Access/],
    ["connect ECONNREFUSED 127.0.0.1:1", /нет соединения/],
  ])("%s", (message, expected) => expect(explainMongoError(message)).toMatch(expected));
  it("неизвестная ошибка показывается как есть", () => expect(explainMongoError("weird")).toBe("MongoDB: weird"));
});

describe("explainWebhook", () => {
  const info = (over: object = {}) => ({ url: URL_OK, pending_update_count: 0, ...over });

  it("нет данных от Telegram → проверить токен", () => expect(explainWebhook(null, URL_OK, NOW)[0]).toMatch(/TELEGRAM_BOT_TOKEN/));
  it("вебхук не зарегистрирован", () => expect(explainWebhook({ url: "", pending_update_count: 2 }, URL_OK, NOW)[0]).toMatch(/не зарегистрирован/));
  it("адрес не совпадает с ожидаемым (в т.ч. неверный путь)", () => {
    const hints = explainWebhook(info({ url: "https://sunrise-gwy8.onrender.com/api/telegram" }), URL_OK, NOW);
    expect(hints[0]).toMatch(/ожидается/);
    expect(explainWebhook(info({ url: URL_OK + "/" }), URL_OK, NOW)).toEqual(["Вебхук выглядит исправным."]); // слэш не считается различием
  });
  it.each([
    ["Wrong response from the webhook: 401 Unauthorized", /secret_token.*TELEGRAM_WEBHOOK_SECRET/],
    ["Wrong response from the webhook: 404 Not Found", /404.*telegram-webhook/],
    ["Wrong response from the webhook: 500 Internal Server Error", /5xx.*Render → Logs/],
    ["Wrong response from the webhook: 502 Bad Gateway", /5xx/],
    ["Connection timed out", /засыпает.*cron-job\.org/],
    ["SSL error {certificate verify failed}", /сертификат/],
    ["Something unexpected", /Последняя ошибка Telegram.*Something unexpected/],
  ])("ошибка доставки «%s»", (msg, expected) => {
    const hints = explainWebhook(info({ last_error_message: msg, last_error_date: ago(7), pending_update_count: 3 }), URL_OK, NOW);
    expect(hints.join(" ")).toMatch(expected);
    expect(hints.join(" ")).toContain("7 мин назад");
  });
  it("очередь без ошибок доставки → сервис принимает, но не обрабатывает (БД)", () => {
    expect(explainWebhook(info({ pending_update_count: 4 }), URL_OK, NOW)[0]).toMatch(/4 необработанных.*MongoDB/);
  });
  it("всё хорошо", () => expect(explainWebhook(info(), URL_OK, NOW)).toEqual(["Вебхук выглядит исправным."]));
});

describe("configProblems", () => {
  it("собирает сообщения об ошибках секций и пропускает исправные", () => {
    const out = configProblems({
      ok: () => ({}),
      telegram: () => { throw new Error("Конфигурация «telegram» неполная — TELEGRAM_BOT_TOKEN: Required"); },
    });
    expect(out).toEqual(["Конфигурация «telegram» неполная — TELEGRAM_BOT_TOKEN: Required"]);
  });
});
