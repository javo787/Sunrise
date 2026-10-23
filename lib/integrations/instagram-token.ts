import { createHash } from "node:crypto";
import { metaConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { getDb } from "@/lib/mongodb";
import { fetchWithRetry, type RetryOptions } from "./http";

const log = createLogger("instagram-token");

// Токен Instagram Login («IGAA…») живёт 60 дней, и Render не даёт приложению менять собственные
// переменные окружения. Поэтому продлённый токен хранится в MongoDB (коллекция credentials), а
// переменная INSTAGRAM_ACCESS_TOKEN служит «семенем»: если её заменили вручную, отсчёт начинается заново.

const DOC_ID = "instagram_token";
const REFRESH_AFTER_MS = 7 * 24 * 3_600_000; // продлеваем раз в неделю: запас до 60 дней огромный
const RETRY_AFTER_MS = 6 * 3_600_000; // после неудачи не долбим Meta чаще, чем раз в 6 часов

interface TokenDoc {
  _id: string;
  token: string;
  /** sha256 токена из окружения, с которого начат отсчёт */
  seedHash: string;
  obtainedAt: Date;
  expiresAt?: Date;
  lastAttemptAt?: Date;
  lastError?: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function tokenCol() {
  return (await getDb()).collection<TokenDoc>("credentials");
}

/** Актуальный токен: продлённый из БД, а при её недоступности или смене переменной — из окружения. */
export async function getInstagramToken(): Promise<string | undefined> {
  const env = metaConfig().INSTAGRAM_ACCESS_TOKEN;
  if (!env) return undefined;
  try {
    const rec = await (await tokenCol()).findOne({ _id: DOC_ID });
    if (rec && rec.seedHash === sha(env)) return rec.token;
  } catch (err) {
    log.warn("не удалось прочитать продлённый токен из БД — используется токен из окружения", { message: errMsg(err) });
  }
  return env;
}

export type TokenRefreshResult = "not_configured" | "fresh" | "backoff" | "refreshed" | "failed";

/** Вызывается из cron: продлевает токен, если с прошлого продления прошло больше недели. */
export async function refreshInstagramTokenIfDue(now: Date = new Date(), retry: RetryOptions = {}): Promise<TokenRefreshResult> {
  const env = metaConfig().INSTAGRAM_ACCESS_TOKEN;
  if (!env) return "not_configured";

  const col = await tokenCol();
  const seedHash = sha(env);
  let rec = await col.findOne({ _id: DOC_ID });

  if (!rec || rec.seedHash !== seedHash) {
    // первый запуск или токен заменили вручную — считаем его свежим и стартуем с нуля
    await col.updateOne(
      { _id: DOC_ID },
      { $set: { token: env, seedHash, obtainedAt: now }, $unset: { expiresAt: "", lastAttemptAt: "", lastError: "" } },
      { upsert: true }
    );
    rec = { _id: DOC_ID, token: env, seedHash, obtainedAt: now };
  }

  if (now.getTime() - rec.obtainedAt.getTime() < REFRESH_AFTER_MS) return "fresh";
  if (rec.lastAttemptAt && now.getTime() - rec.lastAttemptAt.getTime() < RETRY_AFTER_MS) return "backoff";

  await col.updateOne({ _id: DOC_ID }, { $set: { lastAttemptAt: now } });
  try {
    // адрес с токеном в строке запроса нигде не логируем
    const url = `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: rec.token })}`;
    const res = await fetchWithRetry(url, { method: "GET" }, { timeoutMs: 10_000, attempts: 2, ...retry });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
    if (!res.ok || !data.access_token) {
      throw new Error(`Instagram refresh_access_token вернул ${res.status}: ${String(data.error?.message ?? "").slice(0, 200)}`);
    }
    const expiresAt = typeof data.expires_in === "number" ? new Date(now.getTime() + data.expires_in * 1000) : undefined;
    await col.updateOne(
      { _id: DOC_ID },
      { $set: { token: data.access_token, obtainedAt: now, ...(expiresAt ? { expiresAt } : {}) }, $unset: { lastError: "" } }
    );
    log.info("токен Instagram продлён", { expiresAt: expiresAt?.toISOString() });
    return "refreshed";
  } catch (err) {
    const message = errMsg(err);
    await col.updateOne({ _id: DOC_ID }, { $set: { lastError: message.slice(0, 300) } }).catch(() => undefined);
    log.error("не удалось продлить токен Instagram — сгенерируйте новый в Meta for Developers и обновите INSTAGRAM_ACCESS_TOKEN", { message });
    return "failed";
  }
}
