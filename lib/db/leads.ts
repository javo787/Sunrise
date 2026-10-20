import { ObjectId } from "mongodb";
import type { Filter } from "mongodb";
import { isLeadSource, NEW_LEAD_STAGE, type Channel, type LeadSource, type ManagerSheet, type Qualification } from "@/lib/domain/catalog";
import { normalizePhone } from "@/lib/domain/phone";
import { isDuplicateKeyError, leadsCol, type Lead, type LeadClaim, type LeadDoc } from "./collections";

export class InvalidPhoneError extends Error {
  constructor(raw: string) {
    super(`Некорректный номер телефона: «${raw}»`);
    this.name = "InvalidPhoneError";
  }
}

export interface ClaimActor {
  telegramId: number;
  name: string;
  sheetName: ManagerSheet;
}

export interface NewLeadInput {
  name: string;
  phone: string;
  source: LeadSource;
  channel: Channel;
  qualification?: Qualification;
  summary?: string;
  externalId?: string;
  /** Лид сразу закрепляется за менеджером (ручной ввод) и в общую группу не попадает */
  claimBy?: ClaimActor;
}

export type IntakeResult = { kind: "created"; lead: Lead } | { kind: "duplicate"; lead: Lead };

function toClaim(actor: ClaimActor, at: Date): LeadClaim {
  return { managerId: actor.telegramId, managerName: actor.name, sheetName: actor.sheetName, at };
}

/**
 * Создаёт лид, если клиента с таким телефоном ещё нет. Дедупликация атомарна:
 * upsert по уникальному индексу phone, поэтому одновременные вебхуки Meta и WhatsApp
 * про одного клиента не создадут двух лидов.
 */
export async function createLeadIfNew(input: NewLeadInput, now: Date = new Date()): Promise<IntakeResult> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new InvalidPhoneError(input.phone);
  if (!isLeadSource(input.source)) throw new Error(`Источник «${input.source}» отсутствует в справочнике _Lists`);

  const col = await leadsCol();
  const doc: Omit<LeadDoc, "phone"> = {
    name: input.name.trim() || "Без имени",
    source: input.source,
    stage: NEW_LEAD_STAGE,
    channel: input.channel,
    status: input.claimBy ? "claimed" : "pending",
    qualification: input.qualification ?? {},
    summary: input.summary,
    externalId: input.externalId,
    createdAt: now,
    contactCount: 1,
    lastContactAt: now,
    ...(input.claimBy ? { claim: toClaim(input.claimBy, now) } : {}),
    sheet: { status: input.claimBy ? "pending" : "waiting", attempts: 0 },
  };

  try {
    const res = await col.updateOne({ phone }, { $setOnInsert: doc }, { upsert: true });
    if (res.upsertedId) {
      const lead = await col.findOne({ _id: res.upsertedId as ObjectId });
      if (lead) return { kind: "created", lead };
    }
  } catch (err) {
    // Две параллельные вставки: проигравшая получает E11000 — это обычный дубликат.
    if (!isDuplicateKeyError(err)) throw err;
  }

  const existing = await col.findOneAndUpdate(
    { phone },
    { $inc: { contactCount: 1 }, $set: { lastContactAt: now } },
    { returnDocument: "after" }
  );
  if (!existing) throw new Error("Лид исчез между upsert и повторным чтением — повторите обработку");
  return { kind: "duplicate", lead: existing };
}

export type ClaimResult =
  | { ok: true; lead: Lead }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "already_claimed"; lead: Lead };

/**
 * Shark Tank: единственная точка захвата лида. Переход pending → claimed выполняется
 * ОДНИМ атомарным findOneAndUpdate с условием status = 'pending', поэтому при
 * одновременных нажатиях выигрывает ровно один менеджер, а остальные получают отказ.
 */
export async function claimLead(leadId: string, actor: ClaimActor, now: Date = new Date()): Promise<ClaimResult> {
  if (!ObjectId.isValid(leadId)) return { ok: false, reason: "missing" };
  const _id = new ObjectId(leadId);
  const col = await leadsCol();

  const won = await col.findOneAndUpdate(
    { _id, status: "pending" },
    { $set: { status: "claimed", claim: toClaim(actor, now), "sheet.status": "pending" } },
    { returnDocument: "after" }
  );
  if (won) return { ok: true, lead: won };

  const current = await col.findOne({ _id });
  if (!current) return { ok: false, reason: "missing" };
  return { ok: false, reason: "already_claimed", lead: current };
}

export async function getLead(leadId: string): Promise<Lead | null> {
  if (!ObjectId.isValid(leadId)) return null;
  return (await leadsCol()).findOne({ _id: new ObjectId(leadId) });
}

// ---------------------------------------------------------------- публикация карточки

const PUBLISH_LOCK_STALE_MS = 60_000;

/** Блокировка публикации: два воркера не отправят одну карточку дважды. */
export async function lockForPublish(leadId: ObjectId, now: Date = new Date()): Promise<Lead | null> {
  const col = await leadsCol();
  const stale = new Date(now.getTime() - PUBLISH_LOCK_STALE_MS);
  return col.findOneAndUpdate(
    {
      _id: leadId,
      status: "pending",
      publishedAt: { $exists: false },
      $or: [{ publishLockAt: { $exists: false } }, { publishLockAt: { $lt: stale } }],
    },
    { $set: { publishLockAt: now } },
    { returnDocument: "after" }
  );
}

export async function markPublished(leadId: ObjectId, card: { chatId: number; messageId: number }, now: Date = new Date()): Promise<void> {
  const col = await leadsCol();
  await col.updateOne({ _id: leadId }, { $set: { publishedAt: now, card }, $unset: { publishLockAt: "" } });
}

export async function releasePublishLock(leadId: ObjectId): Promise<void> {
  const col = await leadsCol();
  await col.updateOne({ _id: leadId }, { $unset: { publishLockAt: "" } });
}

/** Лиды, которые не удалось отправить в группу (сбой Telegram) — их подхватывает cron. */
export async function listUnpublished(limit = 20): Promise<Lead[]> {
  const col = await leadsCol();
  return col.find({ status: "pending", publishedAt: { $exists: false } }).sort({ createdAt: 1 }).limit(limit).toArray();
}

// ---------------------------------------------------------------- эскалация

export async function findStaleForEscalation(cutoff: Date, limit = 50): Promise<Lead[]> {
  const col = await leadsCol();
  return col
    .find({ status: "pending", publishedAt: { $lte: cutoff }, escalatedAt: { $exists: false } })
    .sort({ publishedAt: 1 })
    .limit(limit)
    .toArray();
}

/** Атомарная отметка: эскалация по одному лиду срабатывает ровно один раз. */
export async function markEscalated(leadId: ObjectId, now: Date = new Date()): Promise<Lead | null> {
  const col = await leadsCol();
  return col.findOneAndUpdate(
    { _id: leadId, status: "pending", escalatedAt: { $exists: false } },
    { $set: { escalatedAt: now } },
    { returnDocument: "after" }
  );
}

// ---------------------------------------------------------------- синхронизация с Google Sheets

const SHEET_LOCK_STALE_MS = 120_000;

export async function lockForSheetSync(leadId: ObjectId, maxAttempts: number, now: Date = new Date()): Promise<Lead | null> {
  const col = await leadsCol();
  const stale = new Date(now.getTime() - SHEET_LOCK_STALE_MS);
  return col.findOneAndUpdate(
    {
      _id: leadId,
      status: "claimed",
      $or: [
        { "sheet.status": "pending" },
        { "sheet.status": "failed", "sheet.attempts": { $lt: maxAttempts } },
        { "sheet.status": "syncing", "sheet.lockAt": { $lt: stale } },
      ],
    },
    { $set: { "sheet.status": "syncing", "sheet.lockAt": now }, $inc: { "sheet.attempts": 1 } },
    { returnDocument: "after" }
  );
}

export async function markSheetSynced(leadId: ObjectId, where: { sheetName: string; row: number }, now: Date = new Date()): Promise<void> {
  const col = await leadsCol();
  await col.updateOne(
    { _id: leadId },
    {
      $set: { "sheet.status": "synced", "sheet.sheetName": where.sheetName, "sheet.row": where.row, "sheet.syncedAt": now },
      $unset: { "sheet.lockAt": "", "sheet.error": "" },
    }
  );
}

export async function markSheetFailed(leadId: ObjectId, error: string): Promise<void> {
  const col = await leadsCol();
  await col.updateOne(
    { _id: leadId },
    { $set: { "sheet.status": "failed", "sheet.error": error.slice(0, 500) }, $unset: { "sheet.lockAt": "" } }
  );
}

export async function listSheetSyncCandidates(maxAttempts: number, now: Date = new Date(), limit = 20): Promise<Lead[]> {
  const col = await leadsCol();
  const stale = new Date(now.getTime() - SHEET_LOCK_STALE_MS);
  const filter: Filter<LeadDoc> = {
    status: "claimed",
    $or: [
      { "sheet.status": "pending" },
      { "sheet.status": "failed", "sheet.attempts": { $lt: maxAttempts } },
      { "sheet.status": "syncing", "sheet.lockAt": { $lt: stale } },
    ],
  };
  return col.find(filter).sort({ createdAt: 1 }).limit(limit).toArray();
}

// ---------------------------------------------------------------- отчётность

export async function listLeadsCreatedBetween(from: Date, to: Date): Promise<Lead[]> {
  const col = await leadsCol();
  return col.find({ createdAt: { $gte: from, $lt: to } }).sort({ createdAt: 1 }).toArray();
}

export async function countPending(): Promise<number> {
  const col = await leadsCol();
  return col.countDocuments({ status: "pending" });
}

/** Откат отметки эскалации, если сообщение в группу не ушло — следующий тик cron повторит. */
export async function clearEscalated(leadId: ObjectId): Promise<void> {
  const col = await leadsCol();
  await col.updateOne({ _id: leadId }, { $unset: { escalatedAt: "" } });
}
