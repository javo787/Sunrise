// Простой структурированный логгер для отладки маршрута
// «вебхук → ИИ → ответ пациенту». Каждая строка содержит время, область
// (webhook/evolution/gemini/db), опциональный requestId (чтобы сшить все
// шаги одного входящего сообщения в единую цепочку в общем выводе логов)
// и шаг с данными в JSON.
//
// requestId генерируется один раз в начале обработки вебхука
// (см. app/api/whatsapp-webhook/route.ts) и прокидывается дальше во все
// вызовы lib/evolution.ts и lib/gemini.ts, чтобы при параллельных
// сообщениях от разных пациентов логи не перемешивались.

type LogLevel = "info" | "warn" | "error";

function ts(): string {
  return new Date().toISOString();
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return '"[не удалось сериализовать данные]"';
  }
}

function line(scope: string, level: LogLevel, requestId: string | undefined, step: string, data?: unknown): string {
  const prefix = `[${ts()}] [${scope}]${requestId ? ` [${requestId}]` : ""} [${level.toUpperCase()}] ${step}`;
  return data === undefined ? prefix : `${prefix} :: ${safeStringify(data)}`;
}

export interface Logger {
  info(step: string, data?: unknown): void;
  warn(step: string, data?: unknown): void;
  error(step: string, data?: unknown): void;
  child(requestId: string): Logger;
}

export function createLogger(scope: string, requestId?: string): Logger {
  return {
    info: (step, data) => console.log(line(scope, "info", requestId, step, data)),
    warn: (step, data) => console.warn(line(scope, "warn", requestId, step, data)),
    error: (step, data) => console.error(line(scope, "error", requestId, step, data)),
    child: (childRequestId: string) => createLogger(scope, childRequestId),
  };
}

// Короткий id для сшивания логов одного входящего сообщения
// (не криптографический, только для читаемости в консоли/логах Vercel).
export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 8);
}
