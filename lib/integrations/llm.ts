import { z } from "zod";
import { llmConfig } from "@/lib/config";
import type { Language, PaymentType } from "@/lib/domain/catalog";
import { createLogger } from "@/lib/logger";
import { fetchWithRetry } from "./http";

const log = createLogger("llm");

export interface LlmTurn {
  role: "user" | "assistant";
  text: string;
  audio?: { base64: string; mimeType: string };
}

export interface LlmRequest {
  system: string;
  turns: LlmTurn[];
}

/** Всё, что модель «услышала» от клиента. null — клиент этого явно не называл. */
export interface LlmExtraction {
  floor: number | null;
  areaSqm: number | null;
  paymentType: PaymentType | null;
  phone: string | null;
  name: string | null;
  language: Language | null;
  wantsHuman: boolean;
  summary: string;
}

export interface LlmResult {
  reply: string;
  extraction: LlmExtraction;
}

export interface LlmClient {
  /** Распознаёт ли клиент голосовые сообщения (аудио передаётся модели напрямую). */
  readonly supportsAudio: boolean;
  generate(req: LlmRequest): Promise<LlmResult>;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

// Устойчивый разбор: одно кривое поле не должно выбрасывать весь ответ модели.
const ReplySchema = z.object({
  reply: z.string().trim().min(1),
  language: z.enum(["ru", "tg"]).nullable().optional().catch(null),
  floor: z.number().int().nullable().optional().catch(null),
  areaSqm: z.number().positive().nullable().optional().catch(null),
  paymentType: z.enum(["installment_50", "full_100"]).nullable().optional().catch(null),
  phone: z.string().nullable().optional().catch(null),
  name: z.string().nullable().optional().catch(null),
  wantsHuman: z.boolean().optional().catch(false),
  summary: z.string().optional().catch(""),
});

export function parseLlmJson(raw: string): LlmResult {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = ReplySchema.parse(JSON.parse(cleaned));
  return {
    reply: parsed.reply,
    extraction: {
      floor: parsed.floor ?? null,
      areaSqm: parsed.areaSqm ?? null,
      paymentType: parsed.paymentType ?? null,
      phone: parsed.phone?.trim() || null,
      name: parsed.name?.trim() || null,
      language: parsed.language ?? null,
      wantsHuman: parsed.wantsHuman ?? false,
      summary: (parsed.summary ?? "").trim(),
    },
  };
}

// ---------------------------------------------------------------- Gemini

const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING", description: "Reply to the client, 1-3 short chat messages separated by blank lines. No markdown." },
    language: { type: "STRING", format: "enum", enum: ["ru", "tg"], description: "Language of the reply: ru = Russian, tg = Tajik (Cyrillic)." },
    floor: { type: "INTEGER", nullable: true, description: "Floor the client explicitly named (-2 basement, -1, 1..22). null if not named." },
    areaSqm: { type: "NUMBER", nullable: true, description: "Area in m2 the client explicitly named. null if not named." },
    paymentType: { type: "STRING", format: "enum", enum: ["installment_50", "full_100"], nullable: true, description: "installment_50 = instalment with 50% down payment, full_100 = full payment. null if not chosen." },
    phone: { type: "STRING", nullable: true, description: "Phone number the client explicitly gave for contact. null otherwise." },
    name: { type: "STRING", nullable: true, description: "Client's name if stated. null otherwise." },
    wantsHuman: { type: "BOOLEAN", description: "true only if the client asks for a human/manager, is upset, or asks something outside the price list." },
    summary: { type: "STRING", description: "1-2 sentences in Russian for the sales manager: what the client wants." },
  },
  required: ["reply", "language", "wantsHuman", "summary"],
  propertyOrdering: ["reply", "language", "floor", "areaSqm", "paymentType", "phone", "name", "wantsHuman", "summary"],
};

const MAX_CYCLES = 2;
const CYCLE_DELAY_MS = 1500;

interface GeminiOptions {
  sleep?: (ms: number) => Promise<void>;
}

function geminiContents(turns: LlmTurn[]) {
  // Соседние реплики одной роли объединяем в один ход (Gemini ждёт чередование).
  const contents: { role: "user" | "model"; parts: Record<string, unknown>[] }[] = [];
  for (const t of turns) {
    const role = t.role === "assistant" ? "model" : "user";
    const parts: Record<string, unknown>[] = [{ text: t.text }];
    if (t.audio) parts.push({ inlineData: { mimeType: t.audio.mimeType, data: t.audio.base64 } });
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (contents[0]?.role === "model") contents.unshift({ role: "user", parts: [{ text: "(начало диалога)" }] });
  return contents;
}

export function createGeminiClient(opts: GeminiOptions = {}): LlmClient {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    supportsAudio: true,
    async generate(req) {
      const cfg = llmConfig();
      const models = [cfg.GEMINI_MODEL, cfg.GEMINI_MODEL_FALLBACK_1, cfg.GEMINI_MODEL_FALLBACK_2].filter(Boolean);
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: geminiContents(req.turns),
        generationConfig: { temperature: 0.4, responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA },
      });
      let lastError = "нет попыток";

      for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
        for (const model of models) {
          let res: Response;
          try {
            res = await fetchWithRetry(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.GEMINI_API_KEY as string }, body },
              { timeoutMs: cfg.LLM_TIMEOUT_MS, attempts: 1 }
            );
          } catch (err) {
            lastError = `${model}: ${err instanceof Error ? err.message : String(err)}`;
            log.warn("Gemini: сетевая ошибка, пробуем следующую модель", { model, lastError });
            continue;
          }

          if (!res.ok) {
            const text = (await res.text().catch(() => "")).slice(0, 300);
            lastError = `${model}: HTTP ${res.status} ${text}`;
            // 4xx кроме 404/429 — ошибка запроса, смена модели не поможет
            if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429) throw new LlmUnavailableError(lastError);
            log.warn("Gemini: модель недоступна, пробуем следующую", { model, status: res.status });
            continue;
          }

          try {
            const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
            const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
            return parseLlmJson(text);
          } catch (err) {
            lastError = `${model}: некорректный ответ модели (${err instanceof Error ? err.message : String(err)})`;
            log.warn("Gemini: не удалось разобрать ответ", { model });
          }
        }
        if (cycle < MAX_CYCLES - 1) await sleep(CYCLE_DELAY_MS * 2 ** cycle);
      }
      throw new LlmUnavailableError(`Gemini недоступен: ${lastError}`);
    },
  };
}

// ---------------------------------------------------------------- OpenAI

const OPENAI_JSON_HINT = `
ФОРМАТ ОТВЕТА — только JSON без пояснений:
{"reply": string (1-3 коротких сообщения через пустую строку), "language": "ru"|"tg", "floor": integer|null, "areaSqm": number|null, "paymentType": "installment_50"|"full_100"|null, "phone": string|null, "name": string|null, "wantsHuman": boolean, "summary": string}`;

export function createOpenAiClient(opts: GeminiOptions = {}): LlmClient {
  void opts;
  return {
    supportsAudio: false,
    async generate(req) {
      const cfg = llmConfig();
      const messages = [
        { role: "system", content: req.system + OPENAI_JSON_HINT },
        ...req.turns.map((t) => ({ role: t.role, content: t.text })),
      ];
      let res: Response;
      try {
        res = await fetchWithRetry(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.OPENAI_API_KEY}` },
            body: JSON.stringify({ model: cfg.OPENAI_MODEL, temperature: 0.4, response_format: { type: "json_object" }, messages }),
          },
          { timeoutMs: cfg.LLM_TIMEOUT_MS, attempts: 3 }
        );
      } catch (err) {
        throw new LlmUnavailableError(`OpenAI недоступен: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) throw new LlmUnavailableError(`OpenAI HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      try {
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return parseLlmJson(data.choices?.[0]?.message?.content ?? "");
      } catch (err) {
        throw new LlmUnavailableError(`OpenAI: некорректный ответ модели (${err instanceof Error ? err.message : String(err)})`);
      }
    },
  };
}

let cached: LlmClient | undefined;

export function getLlmClient(): LlmClient {
  if (!cached) cached = llmConfig().LLM_PROVIDER === "openai" ? createOpenAiClient() : createGeminiClient();
  return cached;
}

export function resetLlmClientForTests(): void {
  cached = undefined;
}
