import { auth as googleAuth, sheets as googleSheets } from "@googleapis/sheets";
import { sheetsConfig } from "@/lib/config";
import { isLeadSource, LEAD_SOURCES, NEW_LEAD_STAGE, PAYMENT_LABELS } from "@/lib/domain/catalog";
import { normalizePhone } from "@/lib/domain/phone";
import { formatSheetDate, type SheetDateFormat } from "@/lib/domain/time";
import type { Lead } from "@/lib/db/collections";
import { createLogger } from "@/lib/logger";

const log = createLogger("sheets");

// ВАЖНО: пишем ТОЛЬКО во входные колонки клиента. Колонки с формулами («Сумма сделки»,
// проверочные колонки справа) не трогаем вообще — запись идёт точечными ячейками, а не
// целой строкой. Колонки находятся по заголовкам первой строки листа, поэтому порядок
// колонок в таблице может меняться без правок кода.

export const SHEET_FIELDS = ["date", "name", "phone", "source", "stage", "floor", "area", "payment", "comment"] as const;
export type SheetField = (typeof SHEET_FIELDS)[number];

/** Без этих колонок запись невозможна; остальные пропускаются, если их нет в таблице. */
export const REQUIRED_FIELDS: readonly SheetField[] = ["name", "phone", "source", "stage"];

// Заголовки по умолчанию — предположение. Реальные задаются переменной SHEETS_COLUMNS
// (JSON вида {"name":"ФИО клиента","phone":"Телефон"}).
export const DEFAULT_COLUMN_HEADERS: Record<SheetField, string> = {
  date: "Дата",
  name: "Имя клиента",
  phone: "Телефон",
  source: "Источник",
  stage: "Стадия",
  floor: "Этаж",
  area: "Площадь, м²",
  payment: "Вид оплаты",
  comment: "Комментарий",
};

export interface SheetsApi {
  getValues(range: string): Promise<string[][]>;
  /** Запись набора ячеек; значения интерпретируются как при ручном вводе (USER_ENTERED). */
  batchUpdate(updates: { range: string; values: (string | number)[][] }[]): Promise<void>;
}

const normHeader = (s: string) => s.toLowerCase().replace(/[\s.,:;()«»"'№_-]/g, "");

export function colLetter(index0: number): string {
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export type ColumnMap = Partial<Record<SheetField, number>>;

export function parseColumnOverrides(raw: string | undefined): Partial<Record<SheetField, string>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SHEETS_COLUMNS — некорректный JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("SHEETS_COLUMNS должен быть JSON-объектом");
  const out: Partial<Record<SheetField, string>> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(SHEET_FIELDS as readonly string[]).includes(k)) throw new Error(`SHEETS_COLUMNS: неизвестное поле «${k}»`);
    if (typeof v !== "string" || !v.trim()) throw new Error(`SHEETS_COLUMNS: у поля «${k}» должен быть непустой заголовок`);
    out[k as SheetField] = v;
  }
  return out;
}

/** Сопоставляет логические поля с индексами колонок по строке заголовков. */
export function resolveColumns(
  headerRow: string[],
  overrides: Partial<Record<SheetField, string>> = {},
  sheetName = "лист"
): ColumnMap {
  const headers = { ...DEFAULT_COLUMN_HEADERS, ...overrides };
  const byNorm = new Map<string, number>();
  headerRow.forEach((h, i) => {
    const key = normHeader(String(h ?? ""));
    if (key && !byNorm.has(key)) byNorm.set(key, i);
  });

  const map: ColumnMap = {};
  for (const field of SHEET_FIELDS) {
    const idx = byNorm.get(normHeader(headers[field]));
    if (idx !== undefined) map[field] = idx;
  }

  const missing = REQUIRED_FIELDS.filter((f) => map[f] === undefined);
  if (missing.length > 0) {
    const list = missing.map((f) => `«${headers[f]}»`).join(", ");
    throw new Error(
      `На листе «${sheetName}» не найдены колонки: ${list}. Проверьте заголовки первой строки или переменную SHEETS_COLUMNS.`
    );
  }
  return map;
}

export function assertSheetValuesAllowed(lead: Pick<Lead, "source">): void {
  if (!isLeadSource(lead.source)) throw new Error(`Источник «${lead.source}» не из справочника _Lists`);
}

export interface BuiltCell {
  field: SheetField;
  value: string | number;
}

/** Значения входных колонок. Стадия новой заявки — всегда «Новый лид». */
export function buildCells(lead: Lead, columns: ColumnMap, opts: { now: Date; tz: string; dateFormat: SheetDateFormat }): BuiltCell[] {
  assertSheetValuesAllowed(lead);
  const q = lead.qualification;
  const comment = [lead.summary, q.notes].filter(Boolean).join(" | ").slice(0, 500);

  const all: Record<SheetField, string | number | undefined> = {
    date: formatSheetDate(lead.createdAt ?? opts.now, opts.tz, opts.dateFormat),
    name: lead.name,
    // апостроф заставляет Google Sheets сохранить «+992…» как текст, а не как число/формулу
    phone: `'+${lead.phone}`,
    source: lead.source,
    stage: NEW_LEAD_STAGE,
    floor: q.floor,
    area: q.areaSqm,
    payment: q.paymentType ? PAYMENT_LABELS[q.paymentType] : undefined,
    comment: comment || undefined,
  };

  return SHEET_FIELDS.filter((f) => columns[f] !== undefined && all[f] !== undefined).map((f) => ({ field: f, value: all[f] as string | number }));
}

const q = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;
const IDEMPOTENCY_LOOKBACK_ROWS = 200;
const MAX_WRITE_ATTEMPTS = 3;

// Записи на один лист сериализуются внутри процесса; от гонки между процессами защищает
// проверка записанной ячейки после записи (см. appendLeadRow).
const sheetLocks = new Map<string, Promise<unknown>>();
function withSheetLock<T>(sheet: string, fn: () => Promise<T>): Promise<T> {
  const prev = sheetLocks.get(sheet) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  sheetLocks.set(sheet, run.catch(() => undefined));
  return run;
}

export interface AppendResult {
  row: number;
  /** true — клиент с таким телефоном уже есть в последних строках листа, новая строка не добавлялась */
  alreadyPresent: boolean;
}

export async function appendLeadRow(
  api: SheetsApi,
  sheetName: string,
  lead: Lead,
  cfg: { headerRow: number; overrides: Partial<Record<SheetField, string>>; tz: string; dateFormat: SheetDateFormat },
  now: Date = new Date()
): Promise<AppendResult> {
  return withSheetLock(sheetName, async () => {
    const headerRange = `${q(sheetName)}!${cfg.headerRow}:${cfg.headerRow}`;
    const header = (await api.getValues(headerRange))[0] ?? [];
    const columns = resolveColumns(header, cfg.overrides, sheetName);
    const cells = buildCells(lead, columns, { now, tz: cfg.tz, dateFormat: cfg.dateFormat });

    const phoneCol = colLetter(columns.phone!);
    const start = cfg.headerRow + 1;

    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      const column = await api.getValues(`${q(sheetName)}!${phoneCol}${start}:${phoneCol}`);

      // Идемпотентность: если процесс упал после записи, но до отметки в БД, не дублируем строку.
      const from = Math.max(0, column.length - IDEMPOTENCY_LOOKBACK_ROWS);
      for (let i = from; i < column.length; i++) {
        if (normalizePhone(column[i]?.[0] ?? "") === lead.phone) return { row: start + i, alreadyPresent: true };
      }

      let free = column.findIndex((r) => !(r?.[0] ?? "").trim());
      if (free === -1) free = column.length;
      const row = start + free;

      await api.batchUpdate(cells.map((c) => ({ range: `${q(sheetName)}!${colLetter(columns[c.field]!)}${row}`, values: [[c.value]] })));

      // Проверка: ячейка телефона должна содержать наш номер (иначе другой процесс записал в ту же строку).
      const check = await api.getValues(`${q(sheetName)}!${phoneCol}${row}`);
      if (normalizePhone(check[0]?.[0] ?? "") === lead.phone) return { row, alreadyPresent: false };
      log.warn("коллизия записи в строку — пробуем следующую свободную", { sheetName, row, attempt });
    }
    throw new Error(`Не удалось записать лид на лист «${sheetName}»: строки заняты другим процессом`);
  });
}

/** Проверка, что все источники и стадия из кода есть на листе _Lists (разметка листа не важна). */
export async function findMissingListValues(api: SheetsApi): Promise<string[]> {
  const rows = await api.getValues(`${q("_Lists")}!A:Z`);
  const present = new Set(rows.flat().map((c) => String(c).trim()));
  return [...LEAD_SOURCES, NEW_LEAD_STAGE].filter((v) => !present.has(v));
}

// ---------------------------------------------------------------- Google API

function loadCredentials(raw: string): Record<string, unknown> {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON: не удалось разобрать JSON (допустим и base64)");
  }
}

let cachedApi: SheetsApi | undefined;

export function getSheetsApi(): SheetsApi {
  if (cachedApi) return cachedApi;
  const cfg = sheetsConfig();
  const auth = new googleAuth.GoogleAuth({
    credentials: loadCredentials(cfg.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = googleSheets({ version: "v4", auth });
  const spreadsheetId = cfg.SHEETS_SPREADSHEET_ID;
  // Таймаут на каждый вызов и 3 повтора при 429/5xx
  const requestOptions = { timeout: 15_000, retry: true, retryConfig: { retry: 3 } };

  cachedApi = {
    async getValues(range) {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: "FORMATTED_VALUE" }, requestOptions);
      return (res.data.values ?? []).map((r) => r.map((c) => String(c ?? "")));
    },
    async batchUpdate(updates) {
      await sheets.spreadsheets.values.batchUpdate(
        { spreadsheetId, requestBody: { valueInputOption: "USER_ENTERED", data: updates } },
        requestOptions
      );
    },
  };
  return cachedApi;
}

export function resetSheetsApiForTests(): void {
  cachedApi = undefined;
}
