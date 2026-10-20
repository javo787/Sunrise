import { buildQuote, describeFloorPrices, formatUsd, getFloorPrice, pricePerSqm, priceListText } from "@/lib/domain/pricing";

describe("прайс-лист", () => {
  it.each([
    [-2, 20000, 18000],
    [-1, 1800, 1500],
    [1, 3000, 2800],
    [22, 1600, 1400],
  ])("фиксированный этаж %i: %i / %i", (floor, i50, f100) => {
    const p = getFloorPrice(floor)!;
    expect(p.installment50).toBe(i50);
    expect(p.full100).toBe(f100);
  });

  it("3 этаж — базовая цена, 21 этаж — по формуле ТЗ ($940 / $890)", () => {
    expect(getFloorPrice(3)).toMatchObject({ installment50: 1300, full100: 1250, kind: "apartment" });
    expect(getFloorPrice(21)).toMatchObject({ installment50: 940, full100: 890 });
  });

  it("каждый этаж с 4 по 21 дешевле предыдущего ровно на $20", () => {
    for (let f = 4; f <= 21; f++) {
      expect(getFloorPrice(f - 1)!.installment50 - getFloorPrice(f)!.installment50).toBe(20);
      expect(getFloorPrice(f - 1)!.full100 - getFloorPrice(f)!.full100).toBe(20);
    }
  });

  it.each([0, 2, 23, 100, -3, 5.5, NaN])("для этажа %p цены в прайсе нет", (floor) => {
    expect(getFloorPrice(floor)).toBeNull();
    expect(pricePerSqm(floor, "full_100")).toBeNull();
  });

  it("расчёт суммы и первого взноса", () => {
    const q = buildQuote(5, "installment_50", 45)!;
    expect(q.pricePerSqm).toBe(1260);
    expect(q.total).toBe(56700);
    expect(q.downPayment).toBe(28350);
    const full = buildQuote(5, "full_100", 45)!;
    expect(full.total).toBe(54450);
    expect(full.downPayment).toBeNull();
  });

  it("без площади сумма не считается", () => {
    expect(buildQuote(5, "full_100")).toMatchObject({ total: null, areaSqm: null });
    expect(buildQuote(5, "full_100", -3)).toMatchObject({ total: null });
  });

  it("справка для ИИ содержит обе цены и сумму", () => {
    const text = describeFloorPrices(10, 50)!;
    expect(text).toContain("$1 160 за м²");
    expect(text).toContain("$1 110 за м²");
    expect(text).toContain("$58 000");
    expect(text).toContain("$55 500");
    expect(describeFloorPrices(2)).toBeNull();
  });

  it("форматирование и общий прайс", () => {
    expect(formatUsd(20000)).toBe("$20 000");
    expect(priceListText()).toContain("21: 940/890");
  });
});
