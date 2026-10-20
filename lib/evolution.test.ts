// Mock the logger to avoid console output during tests
jest.mock("./logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  }),
}));

describe("sendWhatsAppText", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it("should throw if environment variables are missing", async () => {
    delete process.env.EVOLUTION_API_URL;

    // Dynamically import the module so that it picks up the current process.env
    const { sendWhatsAppText } = await import("./evolution");

    await expect(sendWhatsAppText("123", "test")).rejects.toThrow(
      "Evolution API не настроен — заполните EVOLUTION_API_URL, EVOLUTION_API_KEY и EVOLUTION_INSTANCE в .env.local"
    );
  });

  it("передаёт delay (время «печатает…») в теле запроса, только если задан", async () => {
    process.env.EVOLUTION_API_URL = "http://api.evolution.local";
    process.env.EVOLUTION_API_KEY = "test-api-key";
    process.env.EVOLUTION_INSTANCE = "test-instance";

    const { sendWhatsAppText } = await import("./evolution");
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    await sendWhatsAppText("79991234567", "Привет", "req-1", { typingDelayMs: 2500 });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toEqual({ number: "79991234567", text: "Привет", delay: 2500 });

    (global.fetch as jest.Mock).mockClear();
    await sendWhatsAppText("79991234567", "Привет", "req-2");
    const body2 = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body2).not.toHaveProperty("delay");
  });

  it("should successfully send text message", async () => {
    process.env.EVOLUTION_API_URL = "http://api.evolution.local";
    process.env.EVOLUTION_API_KEY = "test-api-key";
    process.env.EVOLUTION_INSTANCE = "test-instance";

    const { sendWhatsAppText } = await import("./evolution");

    // Mock fetch response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    await sendWhatsAppText("79991234567", "Hello world!", "req-123");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://api.evolution.local/message/sendText/test-instance",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: "test-api-key",
        },
        body: JSON.stringify({ number: "79991234567", text: "Hello world!" }),
      }
    );
  });

  it("should retry and eventually succeed after transient failures", async () => {
    process.env.EVOLUTION_API_URL = "http://api.evolution.local";
    process.env.EVOLUTION_API_KEY = "test-api-key";
    process.env.EVOLUTION_INSTANCE = "test-instance";

    const { sendWhatsAppText } = await import("./evolution");

    // "Connection Closed" — типичный временный обрыв WebSocket-сессии
    // Baileys внутри Evolution, из-за которого один и тот же ручной
    // ответ координатора падал три раза подряд с одной и той же ошибкой.
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValueOnce('{"error":"Connection Closed"}'),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    jest.useFakeTimers();
    const result = sendWhatsAppText("79991234567", "Hello world!");
    await jest.runAllTimersAsync();
    await result;
    jest.useRealTimers();

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("should throw network error if fetch fails on every attempt", async () => {
    process.env.EVOLUTION_API_URL = "http://api.evolution.local";
    process.env.EVOLUTION_API_KEY = "test-api-key";
    process.env.EVOLUTION_INSTANCE = "test-instance";

    const { sendWhatsAppText } = await import("./evolution");

    const networkError = new Error("Network offline");
    (global.fetch as jest.Mock).mockRejectedValue(networkError);

    jest.useFakeTimers();
    const assertion = expect(sendWhatsAppText("79991234567", "Hello world!")).rejects.toThrow(
      "Network offline"
    );
    await jest.runAllTimersAsync();
    await assertion;
    jest.useRealTimers();

    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("should throw if response is not ok on every attempt", async () => {
    process.env.EVOLUTION_API_URL = "http://api.evolution.local";
    process.env.EVOLUTION_API_KEY = "test-api-key";
    process.env.EVOLUTION_INSTANCE = "test-instance";

    const { sendWhatsAppText } = await import("./evolution");

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue("Bad Request: invalid number"),
    });

    jest.useFakeTimers();
    const assertion = expect(sendWhatsAppText("invalid", "text")).rejects.toThrow(
      "Evolution API sendText вернул 400: Bad Request: invalid number"
    );
    await jest.runAllTimersAsync();
    await assertion;
    jest.useRealTimers();

    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("markWhatsAppMessagesRead", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      EVOLUTION_API_URL: "http://api.evolution.local",
      EVOLUTION_API_KEY: "test-api-key",
      EVOLUTION_INSTANCE: "test-instance",
    };
    delete process.env.WHATSAPP_MARK_READ;
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  const keys = [
    { id: "3EB0A1", remoteJid: "992900000000@s.whatsapp.net" },
    { id: "3EB0A2", remoteJid: "992900000000@s.whatsapp.net" },
  ];

  it("шлёт «прочитано» на /chat/markMessageAsRead с fromMe=false для каждого сообщения", async () => {
    const { markWhatsAppMessagesRead } = await import("./evolution");
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 201 });

    await expect(markWhatsAppMessagesRead(keys, "req-1")).resolves.toBe(true);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("http://api.evolution.local/chat/markMessageAsRead/test-instance");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", apikey: "test-api-key" });
    expect(JSON.parse(init.body)).toEqual({
      readMessages: [
        { id: "3EB0A1", fromMe: false, remoteJid: "992900000000@s.whatsapp.net" },
        { id: "3EB0A2", fromMe: false, remoteJid: "992900000000@s.whatsapp.net" },
      ],
    });
  });

  it("не бросает ошибку и возвращает false, если шлюз ответил ошибкой", async () => {
    const { markWhatsAppMessagesRead } = await import("./evolution");
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue("Read messages fail"),
    });

    await expect(markWhatsAppMessagesRead(keys)).resolves.toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1); // без повторов: это необязательный штрих
  });

  it("не бросает ошибку и возвращает false при сетевом сбое", async () => {
    const { markWhatsAppMessagesRead } = await import("./evolution");
    (global.fetch as jest.Mock).mockRejectedValue(new Error("ECONNRESET"));

    await expect(markWhatsAppMessagesRead(keys)).resolves.toBe(false);
  });

  it("не ходит в сеть, если ключей нет, Evolution не настроен или функция выключена", async () => {
    const { markWhatsAppMessagesRead } = await import("./evolution");
    await expect(markWhatsAppMessagesRead([])).resolves.toBe(false);

    process.env.WHATSAPP_MARK_READ = "off";
    await expect(markWhatsAppMessagesRead(keys)).resolves.toBe(false);
    delete process.env.WHATSAPP_MARK_READ;

    delete process.env.EVOLUTION_API_URL;
    jest.resetModules();
    const fresh = await import("./evolution");
    await expect(fresh.markWhatsAppMessagesRead(keys)).resolves.toBe(false);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("отбрасывает пустые id/remoteJid и дубликаты, не отправляя мусор шлюзу", async () => {
    const { markWhatsAppMessagesRead } = await import("./evolution");
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 201 });

    await markWhatsAppMessagesRead([
      keys[0],
      keys[0],
      { id: "", remoteJid: "992900000000@s.whatsapp.net" },
      { id: "3EB0A3", remoteJid: "" },
    ]);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.readMessages).toHaveLength(1);
    expect(body.readMessages[0].id).toBe("3EB0A1");
  });
});

