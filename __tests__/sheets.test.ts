import { ObjectId } from "mongodb";
import type { Lead } from "@/lib/db/collections";
import {
  appendLeadRow,
  buildCells,
  colLetter,
  findMissingListValues,
  parseColumnOverrides,
  resolveColumns,
} from "@/lib/integrations/sheets";
import { FakeSheets } from "./helpers/fake-sheets";

const HEADER = ["Дата", "Имя клиента", "Телефон", "Источник", "Стадия", "Этаж", "Площадь, м²", "Вид оплаты", "Комментарий", "Сумма сделки", "Проверка"];
const SHEET = "Менеджер 1";
const cfg = { headerRow: 1, overrides: {}, tz: "Asia/Dushanbe", dateFormat: "dd.MM.yyyy" as const };
const NOW = new Date("2026-10-20T12:00:00Z");

function lead(over: Partial<Lead> = {}): Lead {
  return {
    _id: new ObjectId(),
    name: "Алишер",
    phone: "992931234567",
    source: "WhatsApp",
    stage: "Новый лид",
    channel: "whatsapp",
    status: "claimed",
    qualification: { floor: 5, areaSqm: 45, paymentType: "installment_50" },
    summary: "Хочет 2-комнатную",
    createdAt: NOW,
    contactCount: 1,
    lastContactAt: NOW,
    sheet: { status: "syncing", attempts: 1 },
    ...over,
  } as Lead;
}

const grid = () =>
  new FakeSheets({
    [SHEET]: [
      HEADER,
      ["10.10.2026", "Старый клиент", "+992 90 000 00 01", "Звонок входящий", "Новый лид", "", "", "", "", "=F2*1000", "=IF(C2<>\"\",\"ок\",\"\")"],
      ["", "", "", "", "", "", "", "", "", "=F3*1000", "=IF(C3<>\"\",\"ок\",\"\")"],
      ["", "", "", "", "", "", "", "", "", "=F4*1000", "=IF(C4<>\"\",\"ок\",\"\")"],
    ],
  });

describe("колонки", () => {
  it("colLetter", () => {
    expect([0, 25, 26, 27, 701, 702].map(colLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("находит колонки по заголовкам без учёта регистра, пробелов и пунктуации", () => {
    const map = resolveColumns(["  ИМЯ  клиента ", "ТЕЛЕФОН", "источник:", "Стадия", "Этаж"], {}, SHEET);
    expect(map).toMatchObject({ name: 0, phone: 1, source: 2, stage: 3, floor: 4 });
    expect(map.area).toBeUndefined();
  });

  it("переопределение заголовков через SHEETS_COLUMNS", () => {
    const map = resolveColumns(["ФИО", "Номер", "Канал", "Статус"], { name: "ФИО", phone: "Номер", source: "Канал", stage: "Статус" }, SHEET);
    expect(map).toMatchObject({ name: 0, phone: 1, source: 2, stage: 3 });
  });

  it("нет обязательной колонки — понятная ошибка со списком", () => {
    expect(() => resolveColumns(["Имя клиента", "Источник"], {}, SHEET)).toThrow(/«Телефон», «Стадия»/);
  });

  it("parseColumnOverrides валидирует вход", () => {
    expect(parseColumnOverrides(undefined)).toEqual({});
    expect(parseColumnOverrides('{"name":"ФИО"}')).toEqual({ name: "ФИО" });
    expect(() => parseColumnOverrides("{oops")).toThrow(/JSON/);
    expect(() => parseColumnOverrides('{"zzz":"x"}')).toThrow(/неизвестное поле/);
    expect(() => parseColumnOverrides('{"name":""}')).toThrow(/непустой/);
  });
});

describe("buildCells", () => {
  const columns = resolveColumns(HEADER, {}, SHEET);

  it("только входные колонки; стадия «Новый лид»; телефон как текст", () => {
    const cells = Object.fromEntries(buildCells(lead(), columns, { now: NOW, tz: cfg.tz, dateFormat: cfg.dateFormat }).map((c) => [c.field, c.value]));
    expect(cells).toEqual({
      date: "20.10.2026",
      name: "Алишер",
      phone: "'+992931234567",
      source: "WhatsApp",
      stage: "Новый лид",
      floor: 5,
      area: 45,
      payment: "Рассрочка (взнос 50%)",
      comment: "Хочет 2-комнатную",
    });
  });

  it("пустые данные квалификации не пишутся", () => {
    const cells = buildCells(lead({ qualification: {}, summary: undefined }), columns, { now: NOW, tz: cfg.tz, dateFormat: cfg.dateFormat });
    expect(cells.map((c) => c.field).sort()).toEqual(["date", "name", "phone", "source", "stage"]);
  });

  it("источник вне справочника не допускается", () => {
    expect(() => buildCells(lead({ source: "Instagram Direct" as never }), columns, { now: NOW, tz: cfg.tz, dateFormat: cfg.dateFormat })).toThrow(/_Lists/);
  });
});

describe("appendLeadRow", () => {
  it("пишет в первую строку с пустым телефоном и не трогает колонки с формулами", async () => {
    const api = grid();
    const res = await appendLeadRow(api, SHEET, lead(), cfg, NOW);
    expect(res).toEqual({ row: 3, alreadyPresent: false });

    expect(api.cell(SHEET, 3, 1)).toBe("Алишер");
    expect(api.cell(SHEET, 3, 2)).toBe("+992931234567");
    expect(api.cell(SHEET, 3, 4)).toBe("Новый лид");
    // колонки J и K (формулы) нетронуты, и в них вообще не было записей
    expect(api.cell(SHEET, 3, 9)).toBe("=F3*1000");
    expect(api.writes.some((w) => w.col >= 9)).toBe(false);
    // чужая строка не затронута
    expect(api.cell(SHEET, 2, 1)).toBe("Старый клиент");
  });

  it("повторный вызов не дублирует строку (идемпотентность)", async () => {
    const api = grid();
    const l = lead();
    await appendLeadRow(api, SHEET, l, cfg, NOW);
    const writesAfterFirst = api.writes.length;
    const again = await appendLeadRow(api, SHEET, l, cfg, NOW);
    expect(again).toEqual({ row: 3, alreadyPresent: true });
    expect(api.writes.length).toBe(writesAfterFirst);
  });

  it("два параллельных лида одного менеджера попадают в разные строки", async () => {
    const api = grid();
    const [a, b] = await Promise.all([
      appendLeadRow(api, SHEET, lead({ phone: "992931111111" }), cfg, NOW),
      appendLeadRow(api, SHEET, lead({ phone: "992932222222" }), cfg, NOW),
    ]);
    expect([a.row, b.row].sort()).toEqual([3, 4]);
  });

  it("коллизия с другим процессом: запись повторяется в следующую свободную строку", async () => {
    const api = grid();
    let stolen = false;
    api.afterWrite = (sheet, row) => {
      if (!stolen) {
        stolen = true;
        api.grids.get(sheet)![row - 1][2] = "+992 90 555 55 55"; // чужой телефон затёр наш
      }
    };
    const res = await appendLeadRow(api, SHEET, lead(), cfg, NOW);
    expect(res.row).toBe(4);
    expect(api.cell(SHEET, 4, 2)).toBe("+992931234567");
  });

  it("если нет обязательной колонки — ничего не пишет и падает с понятной ошибкой", async () => {
    const api = new FakeSheets({ [SHEET]: [["Имя клиента", "Источник"]] });
    await expect(appendLeadRow(api, SHEET, lead(), cfg, NOW)).rejects.toThrow(/не найдены колонки/);
    expect(api.writes).toHaveLength(0);
  });

  it("лист с пробелом и апострофом в названии адресуется корректно", async () => {
    const api = new FakeSheets({ "Менеджер 1": [HEADER] });
    await expect(appendLeadRow(api, "Менеджер 1", lead(), cfg, NOW)).resolves.toMatchObject({ row: 2 });
  });
});

describe("справочник _Lists", () => {
  it("находит значения, которых нет на листе", async () => {
    const full = new FakeSheets({
      _Lists: [["Источник", "Стадия"], ["Таргет Instagram", "Новый лид"], ["Таргет Facebook"], ["WhatsApp"], ["Звонок входящий"], ["Somon.tj"], ["Баннер / Наружка"], ["Офис (визит)"], ["Рекомендация"]],
    });
    expect(await findMissingListValues(full)).toEqual([]);

    const partial = new FakeSheets({ _Lists: [["Таргет Instagram", "Новый лид", "WhatsApp"]] });
    const missing = await findMissingListValues(partial);
    expect(missing).toContain("Somon.tj");
    expect(missing).not.toContain("WhatsApp");
  });
});
