import type { Collection, WithId } from "mongodb";
import type { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import type { Channel, LeadSource, ManagerSheet, PaymentType, Qualification } from "@/lib/domain/catalog";
import { NEW_LEAD_STAGE } from "@/lib/domain/catalog";

// Типы документов и доступ к коллекциям. Индексы создаются один раз при первом
// обращении к БД — уникальный индекс по phone критичен для дедупликации клиентов.

/** waiting — лид ещё не закреплён; pending — ждёт записи в Google Sheets; syncing — идёт запись. */
export type SheetStatus = "waiting" | "pending" | "syncing" | "synced" | "failed";

export interface LeadClaim {
  managerId: number; // Telegram ID
  managerName: string;
  sheetName: ManagerSheet;
  at: Date;
}

export interface LeadDoc {
  name: string;
  /** Нормализованный номер (только цифры, с кодом страны) — ключ дедупликации */
  phone: string;
  source: LeadSource;
  stage: typeof NEW_LEAD_STAGE;
  channel: Channel;
  /** pending — ждёт менеджера; claimed — кто-то забрал (атомарный переход) */
  status: "pending" | "claimed";
  qualification: Qualification;
  summary?: string;
  /** leadgen_id Meta / id отправителя Instagram — для трассировки */
  externalId?: string;
  createdAt: Date;
  contactCount: number;
  lastContactAt: Date;
  publishLockAt?: Date;
  publishedAt?: Date;
  card?: { chatId: number; messageId: number };
  escalatedAt?: Date;
  claim?: LeadClaim;
  sheet: {
    status: SheetStatus;
    attempts: number;
    lockAt?: Date;
    sheetName?: string;
    row?: number;
    error?: string;
    syncedAt?: Date;
  };
}
export type Lead = WithId<LeadDoc>;

export interface ManagerDoc {
  telegramId: number;
  name: string;
  username?: string;
  sheetName: ManagerSheet;
  active: boolean;
  createdAt: Date;
}
export type Manager = WithId<ManagerDoc>;

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  at: Date;
}

export interface SessionState extends Qualification {
  /** Телефон клиента (из чата WhatsApp или названный клиентом) */
  phone?: string;
  name?: string;
  /** Сколько раз клиент писал (по пачкам сообщений) — страховка от бесконечного диалога */
  userTurns: number;
}

export interface SessionDoc {
  channel: "whatsapp" | "instagram";
  contactId: string;
  /** Куда отвечать (JID WhatsApp / IGSID) */
  replyTo: string;
  messages: SessionMessage[];
  state: SessionState;
  /** Лид создан и передан менеджерам — бот больше не отвечает */
  handedOff: boolean;
  leadId?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
export type Session = WithId<SessionDoc>;

export interface ProcessedEventDoc {
  key: string;
  createdAt: Date;
}

export interface FailedEventDoc {
  kind: string;
  payload: unknown;
  error: string;
  createdAt: Date;
}

/** Сохранённое входящее сообщение клиента: страховка на случай перезапуска до обработки пачки. */
export interface InboxDoc {
  key: string;
  message: {
    channel: "whatsapp" | "instagram";
    contactId: string;
    replyTo: string;
    phone?: string;
    name?: string;
    text: string;
    /** голосовое: сами аудиоданные в БД не храним, при восстановлении остаётся текстовая пометка */
    hadAudio?: boolean;
  };
  status: "queued" | "processing" | "done" | "failed";
  attempts: number;
  createdAt: Date;
  lockAt?: Date;
}

export interface ReportLogDoc {
  kind: "daily" | "monthly";
  period: string;
  createdAt: Date;
}

export type FlowStep = "name" | "phone" | "source" | "note";
export interface FlowDoc {
  userId: number;
  step: FlowStep;
  data: { name?: string; phone?: string; source?: LeadSource; paymentType?: PaymentType };
  updatedAt: Date;
}

let indexesReady: Promise<void> | undefined;

export function resetIndexCacheForTests(): void {
  indexesReady = undefined;
}

async function createIndexes(): Promise<void> {
  const db = await getDb();
  const DAY = 24 * 60 * 60;
  await Promise.all([
    db.collection("leads").createIndex({ phone: 1 }, { unique: true }),
    db.collection("leads").createIndex({ status: 1, publishedAt: 1 }),
    db.collection("leads").createIndex({ createdAt: -1 }),
    db.collection("leads").createIndex({ "sheet.status": 1 }),
    db.collection("managers").createIndex({ telegramId: 1 }, { unique: true }),
    db.collection("sessions").createIndex({ channel: 1, contactId: 1 }, { unique: true }),
    db.collection("events").createIndex({ key: 1 }, { unique: true }),
    db.collection("events").createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * DAY }),
    db.collection("failed_events").createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * DAY }),
    db.collection("report_log").createIndex({ kind: 1, period: 1 }, { unique: true }),
    db.collection("inbox").createIndex({ status: 1, createdAt: 1 }),
    db.collection("inbox").createIndex({ createdAt: 1 }, { expireAfterSeconds: 3 * DAY }),
    db.collection("tg_flows").createIndex({ userId: 1 }, { unique: true }),
    db.collection("tg_flows").createIndex({ updatedAt: 1 }, { expireAfterSeconds: DAY }),
  ]);
}

export function ensureIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = createIndexes().catch((err) => {
      indexesReady = undefined; // не кэшируем отказ — следующий вызов попробует снова
      throw err;
    });
  }
  return indexesReady;
}

async function col<T extends object>(name: string): Promise<Collection<T>> {
  await ensureIndexes();
  const db = await getDb();
  return db.collection<T>(name);
}

export const leadsCol = () => col<LeadDoc>("leads");
export const managersCol = () => col<ManagerDoc>("managers");
export const sessionsCol = () => col<SessionDoc>("sessions");
export const eventsCol = () => col<ProcessedEventDoc>("events");
export const failedEventsCol = () => col<FailedEventDoc>("failed_events");
export const inboxCol = () => col<InboxDoc>("inbox");
export const reportLogCol = () => col<ReportLogDoc>("report_log");
export const flowsCol = () => col<FlowDoc>("tg_flows");

/** Ошибка дубликата уникального ключа MongoDB (E11000). */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}
