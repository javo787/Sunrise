// Справочники. Значения в LEAD_SOURCES и NEW_LEAD_STAGE ДОЛЖНЫ побуквенно совпадать
// с листом _Lists в таблице SUNRISE CRM — там включена строгая валидация данных.

export const LEAD_SOURCES = [
  "Таргет Instagram",
  "Таргет Facebook",
  "WhatsApp",
  "Звонок входящий",
  "Somon.tj",
  "Баннер / Наружка",
  "Офис (визит)",
  "Рекомендация",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const NEW_LEAD_STAGE = "Новый лид" as const;

/** Источники, из которых менеджер выбирает при ручном вводе через «➕ Добавить клиента». */
export const MANUAL_SOURCES: readonly LeadSource[] = [
  "Звонок входящий",
  "Somon.tj",
  "Баннер / Наружка",
  "Офис (визит)",
  "Рекомендация",
];

/** Персональные листы менеджеров в таблице. */
export const MANAGER_SHEETS = ["Менеджер 1", "Менеджер 2", "Менеджер 3"] as const;
export type ManagerSheet = (typeof MANAGER_SHEETS)[number];

export function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === "string" && (LEAD_SOURCES as readonly string[]).includes(value);
}

export function isManagerSheet(value: unknown): value is ManagerSheet {
  return typeof value === "string" && (MANAGER_SHEETS as readonly string[]).includes(value);
}

export type PaymentType = "installment_50" | "full_100";

export const PAYMENT_LABELS: Record<PaymentType, string> = {
  installment_50: "Рассрочка (взнос 50%)",
  full_100: "Полная оплата (100%)",
};

export type Channel = "whatsapp" | "instagram" | "meta_form" | "manual";
export type Language = "ru" | "tg";

export interface Qualification {
  floor?: number;
  areaSqm?: number;
  paymentType?: PaymentType;
  language?: Language;
  notes?: string;
}

/** Источник по каналу, из которого пришёл диалог/лид (только значения справочника). */
export function sourceForChannel(channel: "whatsapp" | "instagram"): LeadSource {
  return channel === "whatsapp" ? "WhatsApp" : "Таргет Instagram";
}
