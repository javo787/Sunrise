import { fetchWithRetry } from "@/lib/integrations/http";

// Диагностика «почему бот молчит»: переводит технические ошибки Telegram/MongoDB/конфигурации
// в понятные подсказки. Ничего секретного не возвращает (токены и пароли вычищаются).

export interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

/** Убирает из текста пароли в строках подключения и токены бота. */
export function sanitize(text: string, secrets: string[] = []): string {
  let out = text.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, "$1***@");
  for (const s of secrets) if (s) out = out.split(s).join("***");
  return out.replace(/bot\d{6,}:[A-Za-z0-9_-]{10,}/g, "bot***");
}

export function explainMongoError(message: string): string {
  if (/MONGODB_URI не задан/i.test(message)) return "MongoDB: переменная MONGODB_URI не задана в Render.";
  if (/bad auth|authentication failed|auth.*fail/i.test(message))
    return "MongoDB: неверное имя пользователя или пароль в MONGODB_URI. Проверьте пользователя в Atlas → Database & Network Access; спецсимволы в пароле нужно URL-кодировать, а угловые скобки <db_password> из примера должны быть удалены.";
  if (/ENOTFOUND|querySrv|EBADNAME|getaddrinfo/i.test(message))
    return "MongoDB: адрес кластера из MONGODB_URI не находится. Скопируйте строку заново: Atlas → Connect → Drivers.";
  if (/ECONNREFUSED|server selection|timed out|ETIMEDOUT|ReplicaSetNoPrimary|SSL|tls/i.test(message))
    return "MongoDB: нет соединения с кластером. Проверьте Atlas → Network Access (0.0.0.0/0 со статусом Active), что кластер не на паузе и что в MONGODB_URI верный хост.";
  return `MongoDB: ${message}`;
}

const clean = (u: string) => u.replace(/\/+$/, "");

export function explainWebhook(info: WebhookInfo | null, expectedUrl: string | undefined, nowMs: number): string[] {
  if (!info) return ["Не удалось получить информацию о вебхуке у Telegram — проверьте TELEGRAM_BOT_TOKEN (BotFather → /mybots → API Token)."];
  if (!info.url) {
    return ["Вебхук Telegram не зарегистрирован — Telegram не знает, куда присылать сообщения. Выполните setWebhook (DEPLOY.md, шаг 7)."];
  }

  const hints: string[] = [];
  if (expectedUrl && clean(info.url) !== clean(expectedUrl)) {
    hints.push(`Вебхук указывает на «${info.url}», а ожидается «${expectedUrl}». Адрес или путь в setWebhook неверны: путь должен заканчиваться на /api/telegram-webhook.`);
  }

  const err = info.last_error_message;
  if (err) {
    const ago = info.last_error_date ? ` (${Math.max(0, Math.round((nowMs - info.last_error_date * 1000) / 60000))} мин назад)` : "";
    if (/401/.test(err)) hints.push(`Telegram получает 401${ago}: секрет не совпадает. Параметр secret_token в ссылке setWebhook должен быть ТОЧНО равен TELEGRAM_WEBHOOK_SECRET в Render (или secret_token вообще не был указан). Исправьте и выполните setWebhook заново.`);
    else if (/404/.test(err)) hints.push(`Telegram получает 404${ago}: по этому адресу нет обработчика. URL должен заканчиваться на /api/telegram-webhook.`);
    else if (/\b(500|502|503|504)\b/.test(err)) hints.push(`Сервер отвечает ошибкой 5xx${ago}: сервис спал, перезапускался или падает при обработке. Откройте Render → Logs; проверьте /api/health (поля mongo и problems).`);
    else if (/timed? ?out|timeout|connection|refused|resolve/i.test(err)) hints.push(`Таймаут или обрыв соединения${ago}: бесплатный Render засыпает через 15 минут без запросов. Настройте cron-job.org (DEPLOY.md, шаг 8).`);
    else if (/ssl|certificate/i.test(err)) hints.push(`Проблема с HTTPS-сертификатом${ago}: ${err}`);
    else hints.push(`Последняя ошибка Telegram${ago}: ${err}`);
  }

  if (info.pending_update_count > 0 && !err) {
    hints.push(`В очереди Telegram ${info.pending_update_count} необработанных сообщений, а ошибок доставки нет: сервис принимает их, но не обрабатывает (часто — MongoDB недоступна). Смотрите mongo в /api/health и Render → Logs.`);
  }
  if (hints.length === 0) hints.push("Вебхук выглядит исправным.");
  return hints;
}

export async function fetchTelegramState(
  token: string,
  apiRoot = "https://api.telegram.org"
): Promise<{ username?: string; webhook?: WebhookInfo; error?: string }> {
  const call = async <T>(method: string): Promise<T> => {
    const res = await fetchWithRetry(`${apiRoot}/bot${token}/${method}`, {}, { timeoutMs: 8000, attempts: 1 });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(data.description ?? `HTTP ${res.status}`);
    return data.result as T;
  };
  try {
    const [me, webhook] = await Promise.all([call<{ username?: string }>("getMe"), call<WebhookInfo>("getWebhookInfo")]);
    return { username: me.username, webhook };
  } catch (err) {
    return { error: sanitize(err instanceof Error ? err.message : String(err), [token]) };
  }
}

/** Сообщения о неверных/пропущенных переменных по секциям конфигурации (значения не раскрываются). */
export function configProblems(readers: Record<string, () => unknown>): string[] {
  const out: string[] = [];
  for (const read of Object.values(readers)) {
    try {
      read();
    } catch (err) {
      out.push(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}
