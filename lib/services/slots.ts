import type { PaymentType } from "@/lib/domain/catalog";
import { extractPhone } from "@/lib/domain/phone";

// Быстрое извлечение данных из текста регулярками. Это первая линия: она не требует
// вызова модели и страхует от ошибок ИИ. Затем ответ модели уточняет/перекрывает результат.

export interface Slots {
  floor?: number;
  areaSqm?: number;
  paymentType?: PaymentType;
  phone?: string;
}

const FLOOR_WORD = "(?:этаж\\p{L}*|ошёна\\p{L}*|ошена\\p{L}*|қабат\\p{L}*|кабат\\p{L}*)";
const num = (s: string) => Number(s.replace(/\s/g, "").replace(",", "."));

function extractFloor(text: string): number | undefined {
  if (/пентхаус/iu.test(text)) return 22;

  let m = text.match(new RegExp(`(-\\s?[12])\\s*-?\\s*(?:й|ой|ый|ом|м|го)?\\s*${FLOOR_WORD}`, "iu"));
  if (m) return num(m[1].replace(/\s/g, ""));
  if (/минус\s*(?:1|перв\p{L}*|один)(?![\p{L}\d])/iu.test(text)) return -1;
  if (/минус\s*(?:2|втор\p{L}*|два)(?![\p{L}\d])/iu.test(text)) return -2;
  if (/подвал|таххона/iu.test(text)) return -2;

  m = text.match(new RegExp(`(?<![\\d.,+-])(\\d{1,2})\\s*-?\\s*(?:й|ой|ый|ом|м|го|ум|юм)?\\s*${FLOOR_WORD}`, "iu"));
  if (m) return Number(m[1]);
  m = text.match(new RegExp(`${FLOOR_WORD}\\s*(?:№|номер|:|-)?\\s*(-?\\d{1,2})(?!\\d)`, "iu"));
  if (m) return Number(m[1]);
  return undefined;
}

function extractArea(text: string): number | undefined {
  let m = text.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:м2|м²|m2|кв\.?\s*м\p{L}*|кв(?![\p{L}])|квадрат\p{L}*|метр\p{L}*|sqm)/iu);
  if (m) return num(m[1]);
  m = text.match(/площад\p{L}*\s*(?:около|примерно|от)?\s*(\d{1,4}(?:[.,]\d{1,2})?)/iu);
  return m ? num(m[1]) : undefined;
}

function extractPayment(text: string): PaymentType | undefined {
  const installment = /рассрочк|взнос|50\s*%|50\s*процент|тақсим|такс[ие]м|қисм/iu.test(text);
  const full = /полн\p{L}*\s*оплат|100\s*%|100\s*процент|наличн|единовременн|сразу|пурра|якбора/iu.test(text);
  if (installment === full) return undefined; // не названо или противоречиво — уточнит модель
  return installment ? "installment_50" : "full_100";
}

export function extractSlots(text: string): Slots {
  const slots: Slots = {};
  const floor = extractFloor(text);
  const area = extractArea(text);
  const payment = extractPayment(text);
  const phone = extractPhone(text);
  if (floor !== undefined) slots.floor = floor;
  if (area !== undefined) slots.areaSqm = area;
  if (payment) slots.paymentType = payment;
  if (phone) slots.phone = phone;
  return slots;
}
