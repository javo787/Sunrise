import { extractSlots } from "@/lib/services/slots";

describe("extractSlots", () => {
  it.each([
    ["интересует 5 этаж", 5],
    ["5-й этаж", 5],
    ["на 12 этаже", 12],
    ["на 7-м этаже", 7],
    ["этаж 15", 15],
    ["этаж №9", 9],
    ["хочу пентхаус", 22],
    ["подвал нужен под склад", -2],
    ["-1 этаж", -1],
    ["минус первый", -1],
    ["ошёнаи 8", 8],
  ])("этаж: «%s» → %s", (text, floor) => expect(extractSlots(text).floor).toBe(floor));

  it("не принимает за этаж площадь и телефон", () => {
    expect(extractSlots("45 м2, +992 93 123 45 67").floor).toBeUndefined();
    expect(extractSlots("добрый день").floor).toBeUndefined();
  });

  it.each([
    ["45 м2", 45],
    ["площадь 52,5 м²", 52.5],
    ["около 60 квадратов", 60],
    ["80 кв.м", 80],
    ["площадью 75", 75],
  ])("площадь: «%s» → %s", (text, area) => expect(extractSlots(text).areaSqm).toBe(area));

  it("способ оплаты: рассрочка, полная оплата, неопределённо", () => {
    expect(extractSlots("рассрочка с взносом 50%").paymentType).toBe("installment_50");
    expect(extractSlots("плачу сразу, полная оплата").paymentType).toBe("full_100");
    expect(extractSlots("100% наличными").paymentType).toBe("full_100");
    expect(extractSlots("рассрочка или полная оплата?").paymentType).toBeUndefined();
    expect(extractSlots("добрый день").paymentType).toBeUndefined();
  });

  it("всё сразу в одном сообщении", () => {
    expect(extractSlots("Здравствуйте, 5 этаж, 45 м2, рассрочка, мой номер 93 123 45 67")).toEqual({
      floor: 5,
      areaSqm: 45,
      paymentType: "installment_50",
      phone: "992931234567",
    });
  });
});
