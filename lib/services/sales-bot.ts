import type { ObjectId } from "mongodb";
import { sourceForChannel, type Language } from "@/lib/domain/catalog";
import { getFloorPrice } from "@/lib/domain/pricing";
import { normalizePhone } from "@/lib/domain/phone";
import type { Session, SessionMessage, SessionState } from "@/lib/db/collections";
import { recordFailure } from "@/lib/db/events";
import { getOrCreateSession, saveSession } from "@/lib/db/sessions";
import type { IntakeResult, NewLeadInput } from "@/lib/db/leads";
import { dropDuplicateBubbles, limitExclamations, sanitizeBubble, splitIntoBubbles, splitLongBubbles } from "@/lib/humanize";
import type { LlmClient, LlmExtraction, LlmResult, LlmTurn } from "@/lib/integrations/llm";
import { createLogger, type Logger } from "@/lib/logger";
import type { ReadKey } from "@/lib/evolution";
import { buildSystemPrompt, factsKey } from "./prompt";
import { extractSlots } from "./slots";

const baseLog = createLogger("sales-bot");

export interface InboundMessage {
  channel: "whatsapp" | "instagram";
  /** Стабильный ключ собеседника: номер (WhatsApp) или IGSID (Instagram) */
  contactId: string;
  /** Куда отвечать */
  replyTo: string;
  /** Телефон, известный из самого канала (WhatsApp) */
  phone?: string;
  name?: string;
  text: string;
  audio?: { base64: string; mimeType: string };
  readKeys?: ReadKey[];
  /** id записи во входящей очереди (inbox) — по нему сообщение помечается обработанным */
  inboxId?: string;
}

export interface SalesBotDeps {
  llm: LlmClient;
  sendBubbles: (session: Session, bubbles: string[], inbound: InboundMessage[]) => Promise<void>;
  registerLead: (input: NewLeadInput) => Promise<IntakeResult>;
  /** Сообщения клиента ПОСЛЕ передачи лида менеджеру: бот молчит, но менеджер должен их увидеть */
  relayAfterHandoff?: (session: Session, batch: InboundMessage[]) => Promise<unknown>;
  maxUserTurns: number;
  now?: () => Date;
  log?: Logger;
}

export type BotOutcome =
  | { kind: "ignored"; reason: "handed_off" }
  | { kind: "replied"; qualified: boolean; leadCreated: boolean; llmCalls: number; usedFallback: boolean };

const MIN_AREA = 5;
const MAX_AREA = 2000;

const CLOSING: Record<Language, string> = {
  ru: "Спасибо! Передаю вашу заявку менеджеру — он свяжется с вами в ближайшее время.",
  tg: "Ташаккур! Дархости шуморо ба менеҷер супоридам — ӯ ба наздикӣ бо шумо тамос мегирад.",
};

const FALLBACK_ASK_DETAILS: Record<Language, string> = {
  ru: "Здравствуйте! Спасибо за обращение в Sunrise. Подскажите, пожалуйста, какой этаж и площадь вас интересуют и как планируете оплату — рассрочка или полная оплата?",
  tg: "Салом! Ташаккур барои муроҷиат ба Sunrise. Лутфан гӯед, кадом ошёна ва масоҳат шуморо қизиқ мекунад ва пардохтро чӣ тавр ба нақша гирифтаед — бо тақсим ё пурра?",
};

const FALLBACK_ASK_PHONE: Record<Language, string> = {
  ru: "Спасибо за обращение в Sunrise! Оставьте, пожалуйста, номер телефона — менеджер свяжется с вами и ответит на все вопросы.",
  tg: "Ташаккур барои муроҷиат ба Sunrise! Лутфан рақами телефони худро гузоред — менеҷер бо шумо тамос мегирад.",
};

export function isQualified(state: SessionState): boolean {
  return Boolean(state.phone && state.floor !== undefined && state.paymentType);
}

function appendNote(state: SessionState, note: string): SessionState {
  if (state.notes?.includes(note)) return state;
  return { ...state, notes: [state.notes, note].filter(Boolean).join("; ") };
}

/** Данные, найденные регулярками в тексте клиента, перекрывают ранее известные. */
export function mergeSlots(state: SessionState, text: string): SessionState {
  const s = extractSlots(text);
  let next = { ...state };
  if (s.floor !== undefined) next = applyFloor(next, s.floor);
  if (s.areaSqm !== undefined && s.areaSqm >= MIN_AREA && s.areaSqm <= MAX_AREA) next.areaSqm = s.areaSqm;
  if (s.paymentType) next.paymentType = s.paymentType;
  if (s.phone) next.phone = s.phone;
  return next;
}

function applyFloor(state: SessionState, floor: number): SessionState {
  if (getFloorPrice(floor)) return { ...state, floor };
  // Этажа нет в прайсе (0, 2, 23+): не фиксируем как интерес, но менеджер должен об этом знать
  return appendNote(state, `Клиент спрашивал этаж ${floor} (в прайсе нет)`);
}

/** Данные, названные клиентом по версии модели (после проверки), перекрывают регулярки. */
export function mergeExtraction(state: SessionState, ex: LlmExtraction): SessionState {
  let next = { ...state };
  if (ex.floor !== null) next = applyFloor(next, ex.floor);
  if (ex.areaSqm !== null && ex.areaSqm >= MIN_AREA && ex.areaSqm <= MAX_AREA) next.areaSqm = ex.areaSqm;
  if (ex.paymentType) next.paymentType = ex.paymentType;
  const phone = normalizePhone(ex.phone);
  if (phone) next.phone = phone;
  if (ex.name && !next.name) next.name = ex.name;
  if (ex.language) next.language = ex.language;
  return next;
}

function toTurns(messages: SessionMessage[], audio?: InboundMessage["audio"]): LlmTurn[] {
  const turns: LlmTurn[] = messages.map((m) => ({ role: m.role, text: m.text }));
  if (audio) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        turns[i] = { ...turns[i], audio };
        break;
      }
    }
  }
  return turns;
}

export function prepareBubbles(reply: string, recentAssistantTexts: string[]): string[] {
  const bubbles = limitExclamations(splitLongBubbles(splitIntoBubbles(sanitizeBubble(reply))));
  return dropDuplicateBubbles(bubbles, recentAssistantTexts).kept;
}

function describeForManager(state: SessionState): string {
  const parts = [
    state.floor !== undefined ? `этаж ${state.floor}` : null,
    state.areaSqm ? `${state.areaSqm} м²` : null,
    state.paymentType === "installment_50" ? "рассрочка" : state.paymentType === "full_100" ? "полная оплата" : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Интересует: ${parts.join(", ")}.` : "Подробности не уточнялись.";
}

/**
 * Обрабатывает пачку сообщений одного клиента: обновляет данные диалога, при необходимости
 * зовёт модель (цифры цен подставляет код), решает, квалифицирован ли клиент, и в этом
 * случае создаёт лид. Если модель недоступна — лид всё равно не теряется.
 */
export async function handleInboundBatch(deps: SalesBotDeps, batch: InboundMessage[]): Promise<BotOutcome> {
  const log = deps.log ?? baseLog;
  const first = batch[0];
  const now = deps.now?.() ?? new Date();

  const session = await getOrCreateSession(first.channel, first.contactId, first.replyTo, now);
  if (session.handedOff) {
    try {
      await deps.relayAfterHandoff?.(session, batch);
    } catch (err) {
      log.error("не удалось переслать сообщение клиента менеджеру", { message: err instanceof Error ? err.message : String(err) });
    }
    return { kind: "ignored", reason: "handed_off" };
  }

  const text = batch.map((m) => m.text).filter(Boolean).join("\n");
  const audio = batch.find((m) => m.audio)?.audio;
  const phoneFromChat = Boolean(first.phone);

  let state: SessionState = { ...session.state, userTurns: session.state.userTurns + 1 };
  if (!state.phone && first.phone) state.phone = first.phone;
  if (!state.name && first.name) state.name = first.name;
  state = mergeSlots(state, text);

  const messages: SessionMessage[] = [...session.messages, { role: "user", text: text || "[голосовое сообщение]", at: now }];
  const turns = toTurns(messages, audio);

  let result: LlmResult | null = null;
  let llmCalls = 0;
  try {
    result = await deps.llm.generate({ system: buildSystemPrompt(state, { phoneFromChat }), turns });
    llmCalls++;
    const merged = mergeExtraction(state, result.extraction);
    if (factsKey(merged) !== factsKey(state)) {
      // Модель узнала новое (например, «седьмой этаж»), а ответ писала по старой справке — перегенерируем с верными цифрами.
      result = await deps.llm.generate({ system: buildSystemPrompt(merged, { phoneFromChat }), turns });
      llmCalls++;
      state = mergeExtraction(merged, result.extraction);
    } else {
      state = merged;
    }
  } catch (err) {
    log.error("ИИ недоступен — работаем по запасному сценарию", { message: err instanceof Error ? err.message : String(err) });
    result = null;
  }

  const wantsHuman = result?.extraction.wantsHuman ?? false;
  const llmDown = result === null;
  const language: Language = state.language ?? "ru";
  const qualified =
    isQualified(state) ||
    Boolean(state.phone && (wantsHuman || llmDown || state.userTurns >= deps.maxUserTurns));

  let leadId: ObjectId | undefined;
  let leadCreated = false;
  let handedOff = false;

  if (qualified && state.phone) {
    try {
      const intake = await deps.registerLead({
        name: state.name ?? first.name ?? "Без имени",
        phone: state.phone,
        source: sourceForChannel(first.channel),
        channel: first.channel,
        qualification: { floor: state.floor, areaSqm: state.areaSqm, paymentType: state.paymentType, language: state.language, notes: state.notes },
        summary: [result?.extraction.summary || describeForManager(state), llmDown ? "(ИИ был недоступен — диалог не квалифицирован)" : ""].filter(Boolean).join(" "),
        externalId: `${first.channel}:${first.contactId}`,
      });
      leadId = intake.lead._id;
      leadCreated = intake.kind === "created";
      handedOff = true;
    } catch (err) {
      log.error("не удалось создать лид из диалога", { message: err instanceof Error ? err.message : String(err), contactId: first.contactId });
      await recordFailure("lead_from_dialog", { channel: first.channel, contactId: first.contactId, state }, err);
    }
  }

  // Текст ответа клиенту
  const recentAssistant = messages.filter((m) => m.role === "assistant").map((m) => m.text);
  let bubbles: string[];
  if (handedOff) {
    const llmBubbles = result && !result.reply.includes("?") ? prepareBubbles(result.reply, recentAssistant) : [];
    bubbles = [...llmBubbles.slice(0, 2), CLOSING[language]];
  } else if (result) {
    bubbles = prepareBubbles(result.reply, recentAssistant);
  } else {
    bubbles = [state.phone ? FALLBACK_ASK_DETAILS[language] : FALLBACK_ASK_PHONE[language]];
  }
  if (bubbles.length === 0) bubbles = [state.phone ? FALLBACK_ASK_DETAILS[language] : FALLBACK_ASK_PHONE[language]];

  const assistantMessages: SessionMessage[] = bubbles.map((b) => ({ role: "assistant", text: b, at: now }));
  await saveSession(session._id, { messages: [...messages, ...assistantMessages], state, handedOff: handedOff || undefined, leadId }, now);

  try {
    await deps.sendBubbles(session, bubbles, batch);
  } catch (err) {
    log.error("не удалось отправить ответ клиенту", { message: err instanceof Error ? err.message : String(err), channel: first.channel });
    await recordFailure("send_reply", { channel: first.channel, contactId: first.contactId, bubbles }, err);
  }

  return { kind: "replied", qualified: handedOff, leadCreated, llmCalls, usedFallback: llmDown };
}
