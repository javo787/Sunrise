// Нормализация телефонов к виду «только цифры с кодом страны» (992931234567) —
// это ключ дедупликации клиентов, поэтому формат должен быть строго единым.

export const DEFAULT_COUNTRY_CODE = "992"; // Таджикистан

export function normalizePhone(raw: string | null | undefined, defaultCountry: string = DEFAULT_COUNTRY_CODE): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (raw.trim().startsWith("00") && digits.startsWith("00")) digits = digits.slice(2);

  // Локальный формат Таджикистана: 9 цифр (931234567) или 0931234567
  if (digits.length === 9) digits = defaultCountry + digits;
  else if (digits.length === 10 && digits.startsWith("0")) digits = defaultCountry + digits.slice(1);
  // Российский формат 8XXXXXXXXXX → 7XXXXXXXXXX
  else if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);

  if (digits.length < 11 || digits.length > 15) return null;
  // Номера Таджикистана строго 12 цифр — защита от опечаток при вводе
  if (digits.startsWith("992") && digits.length !== 12) return null;
  return digits;
}

/** Первый валидный телефон в свободном тексте сообщения клиента. */
export function extractPhone(text: string, defaultCountry: string = DEFAULT_COUNTRY_CODE): string | null {
  const candidates = text.match(/(?:\+|00)?\d[\d\s().-]{7,18}\d/g) ?? [];
  for (const c of candidates) {
    const n = normalizePhone(c, defaultCountry);
    if (n) return n;
  }
  return null;
}

export function formatPhone(phone: string): string {
  if (phone.startsWith("992") && phone.length === 12) {
    const n = phone.slice(3);
    return `+992 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7, 9)}`;
  }
  return `+${phone}`;
}

export function whatsappLink(phone: string): string {
  return `https://wa.me/${phone}`;
}
