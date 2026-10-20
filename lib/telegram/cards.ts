import { InlineKeyboard } from "grammy";
import { PAYMENT_LABELS, type Qualification } from "@/lib/domain/catalog";
import { formatPhone, whatsappLink } from "@/lib/domain/phone";
import { buildQuote, formatUsd } from "@/lib/domain/pricing";
import { formatDateTimeRu } from "@/lib/domain/time";
import type { Lead } from "@/lib/db/collections";

// Тексты и кнопки Telegram. Все пользовательские данные экранируются под parse_mode=HTML.
// Номер телефона НЕ попадает в карточку для группы — только в личное сообщение победителю.

export const CLAIM_PREFIX = "claim:";
export const NOOP_DATA = "noop";

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const shortId = (lead: Pick<Lead, "_id">): string => lead._id.toHexString().slice(-6).toUpperCase();

export function claimKeyboard(leadId: string): InlineKeyboard {
  return new InlineKeyboard().text("🦈 Забрать в работу", `${CLAIM_PREFIX}${leadId}`);
}

export function claimedKeyboard(managerName: string): InlineKeyboard {
  return new InlineKeyboard().text(`✅ Забрал: ${managerName}`.slice(0, 60), NOOP_DATA);
}

function interestLine(q: Qualification): string | null {
  const parts = [
    q.floor !== undefined ? `этаж ${q.floor}` : null,
    q.areaSqm ? `${q.areaSqm} м²` : null,
    q.paymentType ? PAYMENT_LABELS[q.paymentType].toLowerCase() : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Ориентировочная стоимость по прайсу — если известны этаж и способ оплаты. */
function estimateLine(q: Qualification): string | null {
  if (q.floor === undefined || !q.paymentType) return null;
  const quote = buildQuote(q.floor, q.paymentType, q.areaSqm);
  if (!quote) return "цены по этому этажу в прайсе нет";
  let line = `${formatUsd(quote.pricePerSqm)}/м²`;
  if (quote.total != null) line += ` · итого ≈ ${formatUsd(quote.total)}`;
  if (quote.downPayment != null) line += ` (взнос ${formatUsd(quote.downPayment)})`;
  return line;
}

function detailLines(lead: Lead): string[] {
  const interest = interestLine(lead.qualification);
  const estimate = estimateLine(lead.qualification);
  return [
    `👤 ${esc(lead.name)}`,
    `📍 Источник: ${esc(lead.source)}`,
    ...(interest ? [`🏢 Интерес: ${esc(interest)}`] : []),
    ...(estimate ? [`💵 Ориентир: ${esc(estimate)}`] : []),
    ...(lead.summary ? [`💬 ${esc(lead.summary)}`] : []),
    ...(lead.qualification.notes ? [`📝 ${esc(lead.qualification.notes)}`] : []),
  ];
}

export function renderLeadCard(lead: Lead): string {
  return [`🆕 <b>Новый лид</b> · #${shortId(lead)}`, ...detailLines(lead), "", "🔒 Номер скрыт — нажмите кнопку, чтобы забрать клиента"].join("\n");
}

export function renderClaimedCard(lead: Lead, tz: string): string {
  const claim = lead.claim;
  const footer = claim ? `✅ <b>Забрал: ${esc(claim.managerName)}</b> · ${esc(formatDateTimeRu(claim.at, tz))}` : "✅ Забрали";
  return [`🆕 <b>Лид</b> · #${shortId(lead)}`, ...detailLines(lead), "", footer].join("\n");
}

export function renderContactDm(lead: Lead): string {
  return [
    `✅ <b>Лид ваш</b> · #${shortId(lead)}`,
    `👤 ${esc(lead.name)}`,
    `📞 <code>${esc(formatPhone(lead.phone))}</code>`,
    `💬 WhatsApp: ${whatsappLink(lead.phone)}`,
    ...detailLines(lead).slice(1),
    ...(lead.claim ? ["", `📄 Запись добавляется в таблицу: лист «${esc(lead.claim.sheetName)}»`] : []),
  ].join("\n");
}

export function renderRepeatContact(lead: Lead): string {
  return `🔁 <b>Клиент написал повторно</b> · #${shortId(lead)}\n👤 ${esc(lead.name)} · <code>${esc(formatPhone(lead.phone))}</code>\n📍 Источник: ${esc(lead.source)}`;
}

export interface Mention {
  id: number;
  name: string;
}

export function renderEscalation(lead: Lead, minutes: number, mentions: Mention[]): string {
  const tags = mentions.map((m) => `<a href="tg://user?id=${m.id}">${esc(m.name)}</a>`).join(", ");
  return [`⏰ <b>Лид #${shortId(lead)} не забран уже ${minutes} мин!</b>`, `${esc(lead.name)} · ${esc(lead.source)}`, ...(tags ? ["", tags] : [])].join("\n");
}
