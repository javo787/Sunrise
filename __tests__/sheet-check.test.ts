import { checkSpreadsheet } from "@/lib/services/sheet-check";
import { FakeSheets } from "./helpers/fake-sheets";

const HEADER = ["Дата", "Имя клиента", "Телефон", "Источник", "Стадия", "Этаж", "Площадь, м²", "Вид оплаты", "Комментарий", "Сумма сделки", "Проверка"];
const LISTS = [["Таргет Instagram", "Новый лид"], ["Таргет Facebook"], ["WhatsApp"], ["Звонок входящий"], ["Somon.tj"], ["Баннер / Наружка"], ["Офис (визит)"], ["Рекомендация"]];
const cfg = { headerRow: 1, overrides: {} };

const good = () =>
  new FakeSheets({
    "Менеджер 1": [HEADER, ["10.10.2026", "Старый", "+992 90 000 00 01"]],
    "Менеджер 2": [HEADER],
    "Менеджер 3": [HEADER],
    _Lists: LISTS,
  });

describe("checkSpreadsheet", () => {
  it("всё сходится: найденные колонки, нетронутые заголовки с формулами, следующая строка", async () => {
    const r = await checkSpreadsheet(good(), cfg);
    expect(r.ok).toBe(true);
    expect(r.missingListValues).toEqual([]);
    expect(r.sheets.map((s) => s.sheetName)).toEqual(["Менеджер 1", "Менеджер 2", "Менеджер 3"]);

    const m1 = r.sheets[0];
    expect(m1.mapped).toMatchObject({ name: "Имя клиента", phone: "Телефон", source: "Источник", stage: "Стадия" });
    expect(m1.untouchedHeaders).toEqual(["Сумма сделки", "Проверка"]);
    expect(m1.missingOptional).toEqual([]);
    expect(m1.nextRow).toBe(3);
    expect(r.sheets[1].nextRow).toBe(2);
  });

  it("не хватает обязательной колонки на одном листе — ошибка по этому листу, остальные проверяются", async () => {
    const api = good();
    api.grids.set("Менеджер 2", [["Имя клиента", "Источник", "Стадия"]]);
    const r = await checkSpreadsheet(api, cfg);
    expect(r.ok).toBe(false);
    expect(r.sheets[1]).toMatchObject({ ok: false });
    expect(r.sheets[1].error).toContain("«Телефон»");
    expect(r.sheets[0].ok).toBe(true);
    expect(r.sheets[2].ok).toBe(true);
  });

  it("необязательные колонки отсутствуют — это не ошибка, но они перечислены", async () => {
    const api = good();
    api.grids.set("Менеджер 3", [["Имя клиента", "Телефон", "Источник", "Стадия"]]);
    const r = await checkSpreadsheet(api, cfg);
    expect(r.ok).toBe(true);
    expect(r.sheets[2].missingOptional).toEqual(["date", "floor", "area", "payment", "comment"]);
  });

  it("значения справочника из кода, которых нет в _Lists, выявляются", async () => {
    const api = good();
    api.grids.set("_Lists", [["Таргет Instagram", "Новый лид"], ["WhatsApp"]]);
    const r = await checkSpreadsheet(api, cfg);
    expect(r.ok).toBe(false);
    expect(r.missingListValues).toEqual(expect.arrayContaining(["Таргет Facebook", "Somon.tj", "Рекомендация"]));
    expect(r.missingListValues).not.toContain("WhatsApp");
  });

  it("ошибка чтения листа API (например, листа нет) не прерывает проверку", async () => {
    const api = good();
    const original = api.getValues.bind(api);
    api.getValues = async (range: string) => {
      if (range.startsWith("'_Lists'")) throw new Error("Unable to parse range: _Lists!A:Z");
      return original(range);
    };
    const r = await checkSpreadsheet(api, cfg);
    expect(r.ok).toBe(false);
    expect(r.listsError).toContain("Unable to parse range");
    expect(r.sheets.every((s) => s.ok)).toBe(true);
  });

  it("учитывает переопределённые заголовки", async () => {
    const api = new FakeSheets({
      "Менеджер 1": [["ФИО", "Номер", "Канал", "Статус"]],
      "Менеджер 2": [["ФИО", "Номер", "Канал", "Статус"]],
      "Менеджер 3": [["ФИО", "Номер", "Канал", "Статус"]],
      _Lists: LISTS,
    });
    const r = await checkSpreadsheet(api, { headerRow: 1, overrides: { name: "ФИО", phone: "Номер", source: "Канал", stage: "Статус" } });
    expect(r.ok).toBe(true);
  });
});
