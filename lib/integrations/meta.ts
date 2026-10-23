import { createHmac, timingSafeEqual } from "node:crypto";
import { metaConfig } from "@/lib/config";
import type { LeadSource } from "@/lib/domain/catalog";
import { createLogger } from "@/lib/logger";
import { fetchWithRetry, type RetryOptions } from "./http";
import { getInstagramToken } from "./instagram-token";

const log = createLogger("meta");

// ---------------------------------------------------------------- безопасность вебхука

/**
 * Проверка X-Hub-Signature-256: HMAC-SHA256 от СЫРОГО тела запроса с секретом приложения.
 * Можно передать несколько секретов (основное приложение Meta и приложение Instagram) — подходит любой.
 */
export function verifyMetaSignature(rawBody: string, header: string | null | undefined, appSecrets: string | readonly string[]): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "utf8");
  return (typeof appSecrets === "string" ? [appSecrets] : appSecrets)
    .filter((secret) => secret.length > 0)
    .some((secret) => {
      const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
      return expected.length === given.length && timingSafeEqual(expected, given);
    });
}

/** GET-рукопожатие при подписке на вебхук: возвращает hub.challenge или null. */
export function resolveChallenge(params: URLSearchParams, verifyToken: string): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (params.get("hub.verify_token") !== verifyToken) return null;
  return params.get("hub.challenge");
}

// ---------------------------------------------------------------- разбор входящих событий

export interface LeadgenEvent {
  leadgenId: string;
  pageId?: string;
  formId?: string;
}

export interface InstagramMessageEvent {
  mid: string;
  senderId: string;
  text?: string;
  isEcho: boolean;
}

export interface ParsedMetaPayload {
  leadgens: LeadgenEvent[];
  messages: InstagramMessageEvent[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const asString = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

export function parseMetaPayload(body: unknown): ParsedMetaPayload {
  const out: ParsedMetaPayload = { leadgens: [], messages: [] };
  if (!isObj(body) || !Array.isArray(body.entry)) return out;

  for (const entry of body.entry) {
    if (!isObj(entry)) continue;

    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!isObj(change) || change.field !== "leadgen" || !isObj(change.value)) continue;
      const leadgenId = asString(change.value.leadgen_id);
      if (leadgenId) out.leadgens.push({ leadgenId, pageId: asString(change.value.page_id), formId: asString(change.value.form_id) });
    }

    const accountId = asString(entry.id);
    for (const m of Array.isArray(entry.messaging) ? entry.messaging : []) {
      if (!isObj(m) || !isObj(m.message) || !isObj(m.sender)) continue;
      const mid = asString(m.message.mid);
      const senderId = asString(m.sender.id);
      if (!mid || !senderId) continue;
      if (accountId && senderId === accountId) continue; // сообщение от самого аккаунта (ответ менеджера из приложения) — не клиент
      out.messages.push({ mid, senderId, text: typeof m.message.text === "string" ? m.message.text : undefined, isEcho: m.message.is_echo === true });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Graph API

export interface MetaLead {
  id: string;
  platform?: string;
  fields: Record<string, string>;
}

function graphUrl(path: string, params: Record<string, string> = {}): string {
  const cfg = metaConfig();
  if (!cfg.META_PAGE_ACCESS_TOKEN) throw new Error("META_PAGE_ACCESS_TOKEN не задан (токен страницы Facebook нужен для лид-форм)");
  const qs = new URLSearchParams({ ...params, access_token: cfg.META_PAGE_ACCESS_TOKEN });
  return `https://graph.facebook.com/${cfg.META_GRAPH_VERSION}/${path}?${qs.toString()}`;
}

export async function fetchLeadgen(leadgenId: string, retry: RetryOptions = {}): Promise<MetaLead> {
  const url = graphUrl(encodeURIComponent(leadgenId), { fields: "field_data,platform,created_time,form_id" });
  const res = await fetchWithRetry(url, { method: "GET" }, { timeoutMs: 10_000, attempts: 3, ...retry });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Graph API leadgen ${leadgenId} вернул ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { id?: string; platform?: string; field_data?: { name?: string; values?: unknown[] }[] };
  const fields: Record<string, string> = {};
  for (const f of data.field_data ?? []) {
    if (f.name && Array.isArray(f.values) && f.values.length > 0) fields[f.name] = String(f.values[0]);
  }
  return { id: data.id ?? leadgenId, platform: data.platform, fields };
}

const PHONE_KEYS = ["phone_number", "phone", "mobile_phone", "телефон", "номер_телефона"];
const NAME_KEYS = ["full_name", "name", "имя", "фио"];

export interface MappedMetaLead {
  name: string;
  phone: string | null;
  source: LeadSource;
  notes: string;
}

/** Поля лид-формы → данные лида. Платформа ig → «Таргет Instagram», иначе «Таргет Facebook». */
export function mapLeadFields(lead: MetaLead): MappedMetaLead {
  const lower = new Map(Object.entries(lead.fields).map(([k, v]) => [k.toLowerCase(), v]));
  const pick = (keys: string[]) => keys.map((k) => lower.get(k)).find((v) => v && v.trim());

  const fullName = pick(NAME_KEYS) ?? [lower.get("first_name"), lower.get("last_name")].filter(Boolean).join(" ");
  const used = new Set([...PHONE_KEYS, ...NAME_KEYS, "first_name", "last_name"]);
  const notes = [...lower.entries()]
    .filter(([k, v]) => !used.has(k) && v.trim())
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join("; ")
    .slice(0, 300);

  const platform = (lead.platform ?? "").toLowerCase();
  return {
    name: fullName.trim() || "Без имени",
    phone: pick(PHONE_KEYS)?.trim() ?? null,
    source: platform === "ig" || platform === "instagram" ? "Таргет Instagram" : "Таргет Facebook",
    notes,
  };
}

/**
 * Ответ клиенту в Instagram Direct (окно ответа Meta — 24 часа после его последнего сообщения).
 * Instagram Login (INSTAGRAM_ACCESS_TOKEN) → graph.instagram.com; иначе Facebook Login (токен страницы) → graph.facebook.com.
 */
export async function sendInstagramText(recipientId: string, text: string, retry: RetryOptions = {}): Promise<void> {
  const cfg = metaConfig();
  const igToken = await getInstagramToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;

  if (igToken) {
    url = `https://graph.instagram.com/${cfg.META_GRAPH_VERSION}/${encodeURIComponent(cfg.INSTAGRAM_USER_ID ?? "me")}/messages`;
    headers.Authorization = `Bearer ${igToken}`;
  } else if (cfg.META_PAGE_ACCESS_TOKEN) {
    url = graphUrl("me/messages");
  } else {
    throw new Error("Instagram не настроен: задайте INSTAGRAM_ACCESS_TOKEN (Instagram Login) или META_PAGE_ACCESS_TOKEN (Facebook Login)");
  }

  const res = await fetchWithRetry(
    url,
    { method: "POST", headers, body: JSON.stringify({ recipient: { id: recipientId }, message: { text: text.slice(0, 1000) } }) },
    { timeoutMs: 10_000, attempts: 3, ...retry }
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    log.error("sendInstagramText: Graph API вернул ошибку", { status: res.status, body });
    throw new Error(`Instagram send вернул ${res.status}: ${body}`);
  }
}
