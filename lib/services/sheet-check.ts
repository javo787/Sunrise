import { MANAGER_SHEETS } from "@/lib/domain/catalog";
import { colLetter, findMissingListValues, q, resolveColumns, SHEET_FIELDS, type SheetField, type SheetsApi } from "@/lib/integrations/sheets";

export interface SheetCheck {
  sheetName: string;
  ok: boolean;
  error?: string;
  /** логическое поле → заголовок, найденный на листе */
  mapped: Partial<Record<SheetField, string>>;
  /** необязательные поля, для которых на листе нет колонки (они просто не заполняются) */
  missingOptional: SheetField[];
  /** заголовки листа, которые код не трогает (формулы, проверочные колонки и т.д.) */
  untouchedHeaders: string[];
  /** первая свободная строка (по колонке телефона) */
  nextRow?: number;
}

export interface SpreadsheetCheck {
  ok: boolean;
  sheets: SheetCheck[];
  /** значения справочников из кода, которых нет на листе _Lists (запись с ними была бы отклонена валидацией) */
  missingListValues: string[];
  listsError?: string;
}

/**
 * Диагностика таблицы перед боевым запуском: ничего не записывает, только читает заголовки
 * листов менеджеров и справочник _Lists и сообщает, что не сходится с кодом.
 */
export async function checkSpreadsheet(api: SheetsApi, cfg: { headerRow: number; overrides: Partial<Record<SheetField, string>> }): Promise<SpreadsheetCheck> {
  const sheets: SheetCheck[] = [];

  for (const sheetName of MANAGER_SHEETS) {
    try {
      const header = (await api.getValues(`${q(sheetName)}!${cfg.headerRow}:${cfg.headerRow}`))[0] ?? [];
      const columns = resolveColumns(header, cfg.overrides, sheetName);
      const mappedIdx = new Set(Object.values(columns));

      const phoneCol = colLetter(columns.phone!);
      const start = cfg.headerRow + 1;
      const column = await api.getValues(`${q(sheetName)}!${phoneCol}${start}:${phoneCol}`);
      let free = column.findIndex((r) => !(r?.[0] ?? "").trim());
      if (free === -1) free = column.length;

      sheets.push({
        sheetName,
        ok: true,
        mapped: Object.fromEntries(SHEET_FIELDS.filter((f) => columns[f] !== undefined).map((f) => [f, header[columns[f]!]])) as SheetCheck["mapped"],
        missingOptional: SHEET_FIELDS.filter((f) => columns[f] === undefined),
        untouchedHeaders: header.map((h, i) => ({ h: String(h ?? "").trim(), i })).filter(({ h, i }) => h && !mappedIdx.has(i)).map(({ h }) => h),
        nextRow: start + free,
      });
    } catch (err) {
      sheets.push({ sheetName, ok: false, error: err instanceof Error ? err.message : String(err), mapped: {}, missingOptional: [], untouchedHeaders: [] });
    }
  }

  let missingListValues: string[] = [];
  let listsError: string | undefined;
  try {
    missingListValues = await findMissingListValues(api);
  } catch (err) {
    listsError = err instanceof Error ? err.message : String(err);
  }

  return { ok: sheets.every((s) => s.ok) && missingListValues.length === 0 && !listsError, sheets, missingListValues, listsError };
}

