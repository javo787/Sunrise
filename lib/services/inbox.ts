import { ObjectId } from "mongodb";
import { inboxCol, type InboxDoc } from "@/lib/db/collections";
import { createLogger } from "@/lib/logger";
import type { InboundMessage } from "./sales-bot";

const log = createLogger("inbox");

// Входящая очередь. Вебхуки Meta и Evolution отвечают 200 сразу и повторять доставку не будут,
// а склейка сообщений живёт в памяти процесса. Чтобы перезапуск (деплой, падение) не терял
// сообщения клиентов из окна склейки, каждое сообщение сначала пишется в БД, а после обработки
// помечается выполненным. Необработанные сообщения добирает cron (recoverStaleInbox).

export const RECOVER_AFTER_MS = 3 * 60_000; // окно склейки (до 30 с) + обработка ответа с запасом
const PROCESSING_STALE_MS = 10 * 60_000;
export const MAX_INBOX_ATTEMPTS = 5;

/** Записывает сообщение в очередь; при сбое БД возвращает undefined — обработка идёт без страховки. */
export async function recordInbound(key: string, msg: InboundMessage, now: Date = new Date()): Promise<string | undefined> {
  try {
    const col = await inboxCol();
    const { insertedId } = await col.insertOne({
      key,
      message: {
        channel: msg.channel,
        contactId: msg.contactId,
        replyTo: msg.replyTo,
        ...(msg.phone ? { phone: msg.phone } : {}),
        ...(msg.name ? { name: msg.name } : {}),
        text: msg.text,
        ...(msg.audio ? { hadAudio: true } : {}),
      },
      status: "queued",
      attempts: 0,
      createdAt: now,
    });
    return insertedId.toHexString();
  } catch (err) {
    log.error("не удалось записать сообщение во входящую очередь", { message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

const toIds = (ids: (string | undefined)[]) => ids.filter((id): id is string => !!id && ObjectId.isValid(id)).map((id) => new ObjectId(id));

export async function markInboxDone(ids: (string | undefined)[]): Promise<void> {
  const list = toIds(ids);
  if (list.length === 0) return;
  const col = await inboxCol();
  for (const _id of list) await col.updateOne({ _id }, { $set: { status: "done" }, $unset: { lockAt: "" } });
}

/**
 * Cron: берёт сообщения, которые не были обработаны за RECOVER_AFTER_MS (процесс перезапустился
 * или упал), и прогоняет их через бота теми же пачками по клиентам. Захват каждого сообщения
 * атомарен — два инстанса не обработают одно и то же дважды.
 */
export async function recoverStaleInbox(
  handle: (batch: InboundMessage[]) => Promise<unknown>,
  now: Date = new Date()
): Promise<{ recovered: number; failed: number }> {
  const col = await inboxCol();
  const cutoff = new Date(now.getTime() - RECOVER_AFTER_MS);
  const stale = new Date(now.getTime() - PROCESSING_STALE_MS);

  const candidates = await col
    .find({ $or: [{ status: "queued", createdAt: { $lt: cutoff } }, { status: "processing", lockAt: { $lt: stale } }] })
    .sort({ createdAt: 1 })
    .limit(100)
    .toArray();

  // захват каждой записи; сгруппировать по клиенту, сохранив порядок
  const byKey = new Map<string, (InboxDoc & { _id: ObjectId })[]>();
  for (const c of candidates) {
    if (c.attempts >= MAX_INBOX_ATTEMPTS) {
      await col.updateOne({ _id: c._id }, { $set: { status: "failed" } });
      continue;
    }
    const taken = await col.findOneAndUpdate(
      { _id: c._id, $or: [{ status: "queued" }, { status: "processing", lockAt: { $lt: stale } }] },
      { $set: { status: "processing", lockAt: now }, $inc: { attempts: 1 } },
      { returnDocument: "after" }
    );
    if (!taken) continue;
    byKey.set(taken.key, [...(byKey.get(taken.key) ?? []), taken]);
  }

  let recovered = 0;
  let failed = 0;
  for (const [key, docs] of byKey) {
    const batch: InboundMessage[] = docs.map((d) => ({
      ...d.message,
      text: d.message.text || (d.message.hadAudio ? "[голосовое сообщение]" : ""),
      inboxId: d._id.toHexString(),
    }));
    try {
      await handle(batch);
      await markInboxDone(batch.map((m) => m.inboxId));
      recovered += docs.length;
      log.info("сообщения клиента восстановлены из входящей очереди", { key, count: docs.length });
    } catch (err) {
      failed += docs.length;
      for (const d of docs) await col.updateOne({ _id: d._id }, { $set: { status: "queued" }, $unset: { lockAt: "" } });
      log.error("не удалось обработать восстановленные сообщения — повторим", { key, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { recovered, failed };
}
