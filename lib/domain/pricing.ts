import type { PaymentType } from "./catalog";

// Прайс-лист застройщика, $ за 1 м². Единственный источник цен для калькулятора,
// ИИ-бота и сообщений менеджерам. ИИ цены НЕ считает — ему передаются готовые цифры.

export type FloorKind = "basement" | "shop" | "apartment" | "penthouse";

export interface FloorPrice {
  floor: number;
  kind: FloorKind;
  label: string;
  /** $/м² при 50% взносе (рассрочка) */
  installment50: number;
  /** $/м² при 100% оплате */
  full100: number;
}

export const APARTMENT_FIRST_FLOOR = 3;
export const APARTMENT_LAST_FLOOR = 21;
const APARTMENT_STEP_USD = 20; // на каждый этаж выше 3-го цена падает ровно на $20/м²
const APARTMENT_BASE_50 = 1300;
const APARTMENT_BASE_100 = 1250;
export const INSTALLMENT_DOWN_PAYMENT_SHARE = 0.5;

const FIXED_FLOORS: Record<number, Omit<FloorPrice, "floor">> = {
  [-2]: { kind: "basement", label: "Таххона (подвал)", installment50: 20000, full100: 18000 },
  [-1]: { kind: "shop", label: "Магоза (магазин)", installment50: 1800, full100: 1500 },
  1: { kind: "shop", label: "Магоза (магазин)", installment50: 3000, full100: 2800 },
  22: { kind: "penthouse", label: "Пентхаус", installment50: 1600, full100: 1400 },
};

/** null — для этажа цены в прайсе нет (0, 2, 23+, нецелые): ответ даёт менеджер. */
export function getFloorPrice(floor: number): FloorPrice | null {
  if (!Number.isInteger(floor)) return null;

  const fixed = FIXED_FLOORS[floor];
  if (fixed) return { floor, ...fixed };

  if (floor >= APARTMENT_FIRST_FLOOR && floor <= APARTMENT_LAST_FLOOR) {
    const steps = (floor - APARTMENT_FIRST_FLOOR) * APARTMENT_STEP_USD;
    return {
      floor,
      kind: "apartment",
      label: "Хонаи истикомати (жилая квартира)",
      installment50: APARTMENT_BASE_50 - steps,
      full100: APARTMENT_BASE_100 - steps,
    };
  }
  return null;
}

export function pricePerSqm(floor: number, paymentType: PaymentType): number | null {
  const p = getFloorPrice(floor);
  if (!p) return null;
  return paymentType === "installment_50" ? p.installment50 : p.full100;
}

export interface Quote {
  floor: number;
  label: string;
  kind: FloorKind;
  paymentType: PaymentType;
  pricePerSqm: number;
  areaSqm: number | null;
  total: number | null;
  /** Первый взнос — только для рассрочки */
  downPayment: number | null;
}

export function buildQuote(floor: number, paymentType: PaymentType, areaSqm?: number | null): Quote | null {
  const p = getFloorPrice(floor);
  if (!p) return null;
  const perSqm = paymentType === "installment_50" ? p.installment50 : p.full100;
  const area = areaSqm != null && Number.isFinite(areaSqm) && areaSqm > 0 ? areaSqm : null;
  const total = area != null ? Math.round(perSqm * area) : null;
  return {
    floor,
    label: p.label,
    kind: p.kind,
    paymentType,
    pricePerSqm: perSqm,
    areaSqm: area,
    total,
    downPayment: paymentType === "installment_50" && total != null ? Math.round(total * INSTALLMENT_DOWN_PAYMENT_SHARE) : null,
  };
}

export function formatUsd(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US").replace(/,/g, " ")}`;
}

function floorTitle(p: FloorPrice): string {
  return `Этаж ${p.floor} — ${p.label}`;
}

/** Готовая справка по этажу (и по сумме, если известна площадь) для вставки в промпт ИИ. */
export function describeFloorPrices(floor: number, areaSqm?: number | null): string | null {
  const p = getFloorPrice(floor);
  if (!p) return null;
  const lines = [
    `${floorTitle(p)}:`,
    `• рассрочка (взнос 50%): ${formatUsd(p.installment50)} за м²`,
    `• полная оплата (100%): ${formatUsd(p.full100)} за м²`,
  ];
  if (areaSqm != null && areaSqm > 0) {
    const a = buildQuote(floor, "installment_50", areaSqm)!;
    const b = buildQuote(floor, "full_100", areaSqm)!;
    lines.push(
      `Для ${areaSqm} м²: рассрочка — ${formatUsd(a.total!)} (первый взнос ${formatUsd(a.downPayment!)}), полная оплата — ${formatUsd(b.total!)}.`
    );
  }
  return lines.join("\n");
}

/** Компактный прайс целиком — запасной вариант в системном промпте. */
export function priceListText(): string {
  const rows: string[] = [];
  for (const f of [-2, -1, 1]) {
    const p = getFloorPrice(f)!;
    rows.push(`этаж ${f} (${p.label}): ${p.installment50}/${p.full100}`);
  }
  const apts: string[] = [];
  for (let f = APARTMENT_FIRST_FLOOR; f <= APARTMENT_LAST_FLOOR; f++) {
    const p = getFloorPrice(f)!;
    apts.push(`${f}: ${p.installment50}/${p.full100}`);
  }
  rows.push(`этажи 3–21 (жилые квартиры): ${apts.join(", ")}`);
  const ph = getFloorPrice(22)!;
  rows.push(`этаж 22 (${ph.label}): ${ph.installment50}/${ph.full100}`);
  return `Формат «рассрочка 50% / полная оплата», $ за м²:\n${rows.join("\n")}`;
}
