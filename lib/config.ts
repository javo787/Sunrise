import { z } from "zod";

// Конфигурация проверяется по секциям и лениво: отсутствие, например, SMTP не должно
// ронять приём лидов. Каждая секция при первом обращении валидируется zod-схемой и
// кэшируется; при ошибке бросается понятное сообщение со списком недостающих переменных.

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const str = () => z.preprocess(emptyToUndefined, z.string().trim().min(1));
const optStr = () => z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const num = (def: number) => z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(def));
const csv = z
  .preprocess(emptyToUndefined, z.string().optional())
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const intId = z.string().trim().regex(/^-?\d+$/, "ожидается целое число").transform(Number);

const cache = new Map<string, unknown>();

function section<T>(name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  if (cache.has(name)) return cache.get(name) as T;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`).join("; ");
    throw new Error(`Конфигурация «${name}» неполная или неверная — ${problems}`);
  }
  cache.set(name, parsed.data);
  return parsed.data;
}

export function resetConfigCache(): void {
  cache.clear();
}

export const coreConfig = () =>
  section(
    "core",
    z.object({
      MONGODB_URI: str(),
      MONGODB_DB: z.preprocess(emptyToUndefined, z.string().default("sunrise")),
      TIMEZONE: z.preprocess(emptyToUndefined, z.string().default("Asia/Dushanbe")),
      CRON_SECRET: optStr(),
      ESCALATION_MINUTES: num(15),
      // self — лид, введённый менеджером вручную, сразу закрепляется за ним;
      // pool — уходит в общую группу как обычный (Shark Tank)
      MANUAL_LEADS_ASSIGN: z.preprocess(emptyToUndefined, z.enum(["self", "pool"]).default("self")),
      AI_MAX_USER_TURNS: num(8),
      BATCH_DEBOUNCE_MS: num(6000),
    })
  );

export const telegramConfig = () =>
  section(
    "telegram",
    z.object({
      TELEGRAM_BOT_TOKEN: z.preprocess(emptyToUndefined, z.string().min(10)),
      TELEGRAM_WEBHOOK_SECRET: z.preprocess(
        emptyToUndefined,
        z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, "16–256 символов: латиница, цифры, _ и -")
      ),
      TELEGRAM_MANAGERS_CHAT_ID: z.preprocess(emptyToUndefined, intId),
      TELEGRAM_ADMIN_IDS: csv.transform((ids) => ids.map(Number).filter(Number.isInteger)),
      TELEGRAM_REPORT_CHAT_ID: z.preprocess(emptyToUndefined, intId.optional()),
    })
  );

// Meta: два независимых способа подключить Instagram Direct, их можно использовать вместе.
//  • Instagram Login (рекомендуется): страница Facebook не нужна. INSTAGRAM_ACCESS_TOKEN (токен «IGAA…»)
//    и INSTAGRAM_APP_SECRET («Instagram app secret» из Meta for Developers).
//  • Facebook Login: META_PAGE_ACCESS_TOKEN (токен страницы «EAA…») и META_APP_SECRET
//    (App settings → Basic). Токен страницы нужен и для лид-форм (leadgen).
// Вебхук подписывается секретом того приложения, к которому относится событие, поэтому принимаем любой из двух.
export const metaConfig = () =>
  section(
    "meta",
    z
      .object({
        META_VERIFY_TOKEN: str(),
        META_APP_SECRET: optStr(),
        INSTAGRAM_APP_SECRET: optStr(),
        META_PAGE_ACCESS_TOKEN: optStr(),
        INSTAGRAM_ACCESS_TOKEN: optStr(),
        // необязательно: id профессионального аккаунта Instagram, если отправка через «me» не работает
        INSTAGRAM_USER_ID: optStr(),
        META_GRAPH_VERSION: z.preprocess(emptyToUndefined, z.string().regex(/^v\d+\.\d+$/).default("v23.0")),
      })
      .superRefine((v, ctx) => {
        if (!v.META_APP_SECRET && !v.INSTAGRAM_APP_SECRET) {
          ctx.addIssue({ code: "custom", path: ["META_APP_SECRET"], message: "нужен META_APP_SECRET или INSTAGRAM_APP_SECRET (подпись вебхуков)" });
        }
      })
  );

export const llmConfig = () =>
  section(
    "llm",
    z
      .object({
        LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["gemini", "openai"]).default("gemini")),
        GEMINI_API_KEY: optStr(),
        GEMINI_MODEL: z.preprocess(emptyToUndefined, z.string().default("gemini-2.5-flash")),
        GEMINI_MODEL_FALLBACK_1: z.preprocess(emptyToUndefined, z.string().default("gemini-2.5-flash-lite")),
        GEMINI_MODEL_FALLBACK_2: optStr(),
        OPENAI_API_KEY: optStr(),
        OPENAI_MODEL: z.preprocess(emptyToUndefined, z.string().default("gpt-4o-mini")),
        LLM_TIMEOUT_MS: num(20000),
      })
      .superRefine((v, ctx) => {
        if (v.LLM_PROVIDER === "gemini" && !v.GEMINI_API_KEY) {
          ctx.addIssue({ code: "custom", path: ["GEMINI_API_KEY"], message: "нужен при LLM_PROVIDER=gemini" });
        }
        if (v.LLM_PROVIDER === "openai" && !v.OPENAI_API_KEY) {
          ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "нужен при LLM_PROVIDER=openai" });
        }
      })
  );

export const sheetsConfig = () =>
  section(
    "sheets",
    z.object({
      GOOGLE_SERVICE_ACCOUNT_JSON: str(),
      SHEETS_SPREADSHEET_ID: str(),
      SHEETS_HEADER_ROW: num(1),
      SHEETS_COLUMNS: optStr(),
      SHEETS_DATE_FORMAT: z.preprocess(emptyToUndefined, z.enum(["dd.MM.yyyy", "yyyy-MM-dd", "MM/dd/yyyy"]).default("dd.MM.yyyy")),
      SHEETS_SYNC_MAX_ATTEMPTS: num(10),
    })
  );

export const mailConfig = () =>
  section(
    "mail",
    z.object({
      SMTP_HOST: str(),
      SMTP_PORT: num(587),
      SMTP_USER: str(),
      SMTP_PASS: str(),
      SMTP_FROM: str(),
      REPORT_EMAIL_TO: csv.refine((l) => l.length > 0, "укажите хотя бы один адрес"),
    })
  );

/** true, если секция сконфигурирована (для /api/health и мягкого отключения функций). */
export function isConfigured(read: () => unknown): boolean {
  try {
    read();
    return true;
  } catch {
    return false;
  }
}
