import { isLeadSource, LEAD_SOURCES, MANUAL_SOURCES, NEW_LEAD_STAGE, sourceForChannel } from "@/lib/domain/catalog";

describe("справочники _Lists", () => {
  it("источники и стадия совпадают со справочником таблицы побуквенно", () => {
    expect([...LEAD_SOURCES]).toEqual([
      "Таргет Instagram",
      "Таргет Facebook",
      "WhatsApp",
      "Звонок входящий",
      "Somon.tj",
      "Баннер / Наружка",
      "Офис (визит)",
      "Рекомендация",
    ]);
    expect(NEW_LEAD_STAGE).toBe("Новый лид");
  });
  it("ручные источники — подмножество справочника", () => {
    for (const s of MANUAL_SOURCES) expect(isLeadSource(s)).toBe(true);
  });
  it("источник по каналу всегда из справочника", () => {
    expect(isLeadSource(sourceForChannel("whatsapp"))).toBe(true);
    expect(isLeadSource(sourceForChannel("instagram"))).toBe(true);
    expect(isLeadSource("Instagram Direct")).toBe(false);
  });
});
