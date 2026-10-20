import { extractPhone, formatPhone, normalizePhone } from "@/lib/domain/phone";

describe("normalizePhone", () => {
  it.each([
    ["+992 93 123 45 67", "992931234567"],
    ["992931234567", "992931234567"],
    ["931234567", "992931234567"],
    ["0931234567", "992931234567"],
    ["00992931234567", "992931234567"],
    ["8 (916) 123-45-67", "79161234567"],
    ["+7 916 123 45 67", "79161234567"],
  ])("%s → %s", (raw, expected) => expect(normalizePhone(raw)).toBe(expected));

  it.each(["", "abc", "12345", "99293123", "9929312345678", "+992 93 123 456"])("отклоняет %p", (raw) =>
    expect(normalizePhone(raw)).toBeNull()
  );

  it("не принимает null/undefined", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe("extractPhone / formatPhone", () => {
  it("находит телефон в свободном тексте", () => {
    expect(extractPhone("мой номер +992 93 123-45-67, звоните после 18:00")).toBe("992931234567");
    expect(extractPhone("хочу 5 этаж, 45 м2")).toBeNull();
  });
  it("форматирует номер Таджикистана", () => {
    expect(formatPhone("992931234567")).toBe("+992 93 123 45 67");
    expect(formatPhone("79161234567")).toBe("+79161234567");
  });
});
