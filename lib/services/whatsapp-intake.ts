import { timingSafeEqual } from "node:crypto";
import { resolveWhatsAppJid } from "@/lib/whatsapp-jid";
import type { InboundMessage } from "./sales-bot";

// Приём вебхука Evolution API (MESSAGES_UPSERT). Вебхук отвечает 200 сразу, а разбор и
// ответ клиенту идут асинхронно; повторы доставки отсекаются по id сообщения.

export type ParsedWhatsApp =
  | {
      kind: "message";
      id: string;
      contactId: string;
      replyTo: string;
      phone?: string;
      name?: string;
      text: string;
      hasAudio: boolean;
      remoteJid: string;
      /** ключ сообщения целиком — нужен для скачивания медиа */
      key: unknown;
    }
  | { kind: "ignore"; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function parseEvolutionMessage(body: unknown): ParsedWhatsApp {
  if (!isObj(body)) return { kind: "ignore", reason: "not_object" };
  const event = String(body.event ?? "").toLowerCase().replace(/_/g, ".");
  if (event !== "messages.upsert") return { kind: "ignore", reason: `event:${event || "none"}` };

  const data = Array.isArray(body.data) ? body.data[0] : body.data;
  if (!isObj(data) || !isObj(data.key)) return { kind: "ignore", reason: "no_data" };
  const key = data.key;

  if (key.fromMe === true) return { kind: "ignore", reason: "from_me" };
  const id = str(key.id);
  const remoteJid = str(key.remoteJid);
  if (!id || !remoteJid) return { kind: "ignore", reason: "no_id" };

  const jid = resolveWhatsAppJid({ remoteJid, remoteJidAlt: str(key.remoteJidAlt), senderPn: str(data.senderPn) });
  if (jid.kind === "ignore") return { kind: "ignore", reason: jid.reason };

  const message = isObj(data.message) ? data.message : {};
  const extended = isObj(message.extendedTextMessage) ? message.extendedTextMessage : {};
  const image = isObj(message.imageMessage) ? message.imageMessage : {};
  const video = isObj(message.videoMessage) ? message.videoMessage : {};
  const text = str(message.conversation) ?? str(extended.text) ?? str(image.caption) ?? str(video.caption) ?? "";
  const hasAudio = isObj(message.audioMessage);

  if (!text && !hasAudio) return { kind: "ignore", reason: "unsupported_media" };

  const base = { kind: "message" as const, id, text, hasAudio, remoteJid, key, name: str(data.pushName) };
  return jid.kind === "phone"
    ? { ...base, contactId: jid.phone, replyTo: jid.phone, phone: jid.phone }
    : { ...base, contactId: jid.replyTo, replyTo: jid.replyTo };
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Аутентификация вебхука. Предпочтительно общий секрет (WHATSAPP_WEBHOOK_SECRET) в заголовке
 * x-webhook-secret или параметре ?secret=; запасной вариант — apikey инстанса в теле события.
 * Без единого настроенного секрета вебхук принимается только вне production.
 */
export function isEvolutionAuthorized(args: {
  bodyApiKey?: string;
  headerSecret?: string | null;
  querySecret?: string | null;
  webhookSecret?: string;
  apiKey?: string;
  production: boolean;
}): boolean {
  if (args.webhookSecret) {
    const given = args.headerSecret ?? args.querySecret ?? "";
    return safeEqual(given, args.webhookSecret);
  }
  if (args.apiKey) return safeEqual(args.bodyApiKey ?? "", args.apiKey);
  return !args.production;
}

export interface WhatsAppIntakeDeps {
  batcher: { push: (key: string, item: InboundMessage) => void | Promise<void> };
  claimEvent: (key: string) => Promise<boolean>;
  supportsAudio: boolean;
  fetchAudio: (key: unknown) => Promise<{ base64: string; mimetype: string }>;
}

export async function processEvolutionEvent(body: unknown, deps: WhatsAppIntakeDeps): Promise<"queued" | "duplicate" | "ignored"> {
  const parsed = parseEvolutionMessage(body);
  if (parsed.kind === "ignore") return "ignored";
  if (!(await deps.claimEvent(`wa:${parsed.id}`))) return "duplicate";

  let text = parsed.text;
  let audio: InboundMessage["audio"];
  if (parsed.hasAudio) {
    if (deps.supportsAudio) {
      try {
        const media = await deps.fetchAudio(parsed.key);
        audio = { base64: media.base64, mimeType: media.mimetype || "audio/ogg" };
      } catch {
        text = text || "[голосовое сообщение — не удалось получить]";
      }
    } else {
      text = text || "[голосовое сообщение]";
    }
  }

  await deps.batcher.push(`whatsapp:${parsed.contactId}`, {
    channel: "whatsapp",
    contactId: parsed.contactId,
    replyTo: parsed.replyTo,
    phone: parsed.phone,
    name: parsed.name,
    text,
    audio,
    readKeys: [{ id: parsed.id, remoteJid: parsed.remoteJid }],
  });
  return "queued";
}
