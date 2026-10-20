import { describeFloorPrices, getFloorPrice, priceListText } from "@/lib/domain/pricing";
import type { SessionState } from "@/lib/db/collections";

// Системный промпт ИИ-ассистента первой линии. Цифры в ответах берутся ТОЛЬКО из блока
// «СПРАВКА», который собирает код из прайс-листа (lib/domain/pricing.ts): модель цены не считает.

const STATIC_PROMPT = `Ты — ассистент отдела продаж застройщика Sunrise в чате (WhatsApp / Instagram Direct). Твоя задача — быстро и вежливо квалифицировать клиента и передать его менеджеру.

ЯЗЫК. Отвечай на языке клиента: русский (ru) или таджикский (tg, кириллица). Если непонятно — русский. Никогда не пиши арабской графикой.

СТИЛЬ. Пиши как живой человек в мессенджере: 1–3 коротких сообщения, каждое 1–2 предложения, через пустую строку. Без markdown, списков, заголовков и эмодзи-россыпей. Не больше одного вопроса за раз. Не повторяй приветствие и то, что уже говорил.

ЧТО НУЖНО УЗНАТЬ: (1) какой этаж / тип помещения и желаемая площадь в м²; (2) способ оплаты — рассрочка (взнос 50%) или полная оплата (100%); (3) телефон для связи, если его ещё нет.

ЦЕНЫ. Называй цены только из блоков «СПРАВКА» и «ПРАЙС» ниже, ничего не считай и не округляй сам. Не придумывай скидки, акции, сроки сдачи, адрес, планировки, условия ипотеки. Если спрашивают о том, чего нет в справке, скажи, что менеджер уточнит и расскажет подробно.

ЭТАЖИ. -2 — подвал (таххона), -1 и 1 — магазины (магоза), 3–21 — жилые квартиры, 22 — пентхаус. Если клиент говорит «магазин» и не уточняет этаж (-1 или 1), спроси этаж.

ИЗВЛЕЧЕНИЕ ДАННЫХ. Поля floor, areaSqm, paymentType, phone, name заполняй, ТОЛЬКО если клиент сам явно это назвал (в этом или прошлых сообщениях); иначе null. Ничего не выдумывай.

wantsHuman = true, если клиент просит живого человека или менеджера, раздражён или задаёт вопрос вне компетенции. В этом случае, если телефона нет, попроси его.

МЕДИА. Если вместо текста клиента стоит пометка в квадратных скобках (голосовое, фото), которое ты не видишь, вежливо попроси написать текстом.

summary — 1–2 предложения по-русски для менеджера: что хочет клиент.`;

export type NextStep = "floor" | "payment" | "phone" | "done";

export function nextStep(state: SessionState): NextStep {
  if (state.floor === undefined) return "floor";
  if (!state.paymentType) return "payment";
  if (!state.phone) return "phone";
  return "done";
}

const STEP_HINT: Record<NextStep, string> = {
  floor: "узнай, какой этаж или тип помещения интересует и какая нужна площадь (м²).",
  payment: "дай цифры по этажу из справки и спроси способ оплаты: рассрочка (взнос 50%) или полная оплата.",
  phone: "попроси номер телефона, по которому менеджеру удобно связаться.",
  done: "поблагодари; менеджер скоро свяжется.",
};

export function buildFactsBlock(state: SessionState, opts: { phoneFromChat: boolean }): string {
  const lines: string[] = ["ИЗВЕСТНО О КЛИЕНТЕ:"];
  lines.push(`- этаж: ${state.floor ?? "не назван"}`);
  lines.push(`- площадь: ${state.areaSqm ? `${state.areaSqm} м²` : "не названа"}`);
  lines.push(`- оплата: ${state.paymentType === "installment_50" ? "рассрочка (взнос 50%)" : state.paymentType === "full_100" ? "полная оплата" : "не выбрана"}`);
  lines.push(`- телефон: ${state.phone ? (opts.phoneFromChat ? "есть (номер этого чата)" : "есть") : "нет"}`);
  lines.push(`СЛЕДУЮЩИЙ ШАГ: ${STEP_HINT[nextStep(state)]}`);

  if (state.floor !== undefined) {
    const info = describeFloorPrices(state.floor, state.areaSqm);
    lines.push("");
    lines.push("СПРАВКА ПО ЭТАЖУ КЛИЕНТА (точные цифры):");
    lines.push(info ?? `Для этажа ${state.floor} цены в прайсе нет — не называй цену, скажи, что стоимость уточнит менеджер.`);
  }
  return lines.join("\n");
}

export function buildSystemPrompt(state: SessionState, opts: { phoneFromChat: boolean }): string {
  return [STATIC_PROMPT, "", buildFactsBlock(state, opts), "", "ПРАЙС ЦЕЛИКОМ:", priceListText()].join("\n");
}

/** Ключ «что мы знаем» — если он поменялся после ответа модели, ответ нужно перегенерировать. */
export function factsKey(state: SessionState): string {
  return [state.floor, state.areaSqm, state.paymentType, state.phone ? "p" : ""].join("|");
}

export const FLOOR_IN_PRICE_LIST = (floor: number) => getFloorPrice(floor) !== null;
