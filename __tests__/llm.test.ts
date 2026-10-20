import { resetConfigCache } from "@/lib/config";
import { createGeminiClient, createOpenAiClient, LlmUnavailableError, parseLlmJson } from "@/lib/integrations/llm";

const noSleep = async () => undefined;
const okBody = (payload: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 });
const goodPayload = { reply: "Здравствуйте!", language: "ru", floor: 5, wantsHuman: false, summary: "Хочет 5 этаж" };

beforeEach(() => {
  Object.assign(process.env, {
    LLM_PROVIDER: "gemini",
    GEMINI_API_KEY: "KEY",
    GEMINI_MODEL: "m-main",
    GEMINI_MODEL_FALLBACK_1: "m-fb1",
    GEMINI_MODEL_FALLBACK_2: "m-fb2",
    OPENAI_API_KEY: "OKEY",
  });
  resetConfigCache();
});
afterEach(() => jest.restoreAllMocks());

describe("parseLlmJson", () => {
  it("разбирает ответ, в том числе в code fence", () => {
    const r = parseLlmJson("```json\n" + JSON.stringify(goodPayload) + "\n```");
    expect(r.reply).toBe("Здравствуйте!");
    expect(r.extraction).toMatchObject({ floor: 5, areaSqm: null, paymentType: null, phone: null, wantsHuman: false, summary: "Хочет 5 этаж" });
  });
  it("одно кривое поле не выбрасывает весь ответ", () => {
    const r = parseLlmJson(JSON.stringify({ ...goodPayload, floor: "пятый", paymentType: "кредит", areaSqm: -3 }));
    expect(r.reply).toBe("Здравствуйте!");
    expect(r.extraction).toMatchObject({ floor: null, paymentType: null, areaSqm: null });
  });
  it("без reply или не JSON — ошибка", () => {
    expect(() => parseLlmJson(JSON.stringify({ language: "ru" }))).toThrow();
    expect(() => parseLlmJson("просто текст")).toThrow();
  });
});

describe("Gemini", () => {
  it("успешный вызов: ключ в заголовке, системная инструкция, соседние реплики склеены", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(okBody(goodPayload));
    const r = await createGeminiClient({ sleep: noSleep }).generate({
      system: "SYS",
      turns: [
        { role: "user", text: "привет" },
        { role: "user", text: "5 этаж", audio: { base64: "AAA", mimeType: "audio/ogg" } },
        { role: "assistant", text: "ответ" },
        { role: "user", text: "рассрочка" },
      ],
    });
    expect(r.extraction.floor).toBe(5);

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/models/m-main:generateContent");
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "KEY" });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.systemInstruction.parts[0].text).toBe("SYS");
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[0].parts).toHaveLength(3); // два текста + аудио
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("при 503 переключается на резервную модель", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("overloaded", { status: 503 })).mockResolvedValueOnce(okBody(goodPayload));
    await createGeminiClient({ sleep: noSleep }).generate({ system: "S", turns: [{ role: "user", text: "x" }] });
    expect(String(spy.mock.calls[1][0])).toContain("m-fb1");
  });

  it("если все модели недоступны — LlmUnavailableError после двух кругов", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    await expect(createGeminiClient({ sleep: noSleep }).generate({ system: "S", turns: [{ role: "user", text: "x" }] })).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(spy).toHaveBeenCalledTimes(6);
  });

  it("ошибка запроса (400) — сразу отказ без перебора моделей", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad schema", { status: 400 }));
    await expect(createGeminiClient({ sleep: noSleep }).generate({ system: "S", turns: [{ role: "user", text: "x" }] })).rejects.toThrow(/400/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("битый JSON в ответе → пробует следующую модель", async () => {
    const broken = new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "не json" }] } }] }), { status: 200 });
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(broken).mockResolvedValueOnce(okBody(goodPayload));
    const r = await createGeminiClient({ sleep: noSleep }).generate({ system: "S", turns: [{ role: "user", text: "x" }] });
    expect(r.reply).toBe("Здравствуйте!");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("OpenAI", () => {
  it("успешный вызов в режиме json_object", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodPayload) } }] }), { status: 200 }));
    const r = await createOpenAiClient().generate({ system: "SYS", turns: [{ role: "user", text: "привет" }] });
    expect(r.extraction.floor).toBe(5);
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("SYS");
    expect(body.messages[1]).toEqual({ role: "user", content: "привет" });
  });

  it("ошибка API → LlmUnavailableError", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("quota", { status: 400 }));
    await expect(createOpenAiClient().generate({ system: "S", turns: [{ role: "user", text: "x" }] })).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
