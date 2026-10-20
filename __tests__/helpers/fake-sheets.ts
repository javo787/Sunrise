import type { SheetsApi } from "@/lib/integrations/sheets";

// Фейковая таблица: хранит ячейки по листам и понимает A1-диапазоны, которые использует код
// ('Лист'!3:3, 'Лист'!C2:C, 'Лист'!C7, 'Лист'!A:Z). Как и настоящий API, обрезает пустые хвосты.
const colToIndex = (letters: string) => letters.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export class FakeSheets implements SheetsApi {
  grids = new Map<string, string[][]>();
  writes: { sheet: string; row: number; col: number; value: string }[] = [];
  /** вызывается после записи — позволяет смоделировать параллельного писателя */
  afterWrite?: (sheet: string, row: number) => void;
  failWrites = false;

  constructor(init: Record<string, string[][]> = {}) {
    for (const [name, rows] of Object.entries(init)) this.grids.set(name, rows.map((r) => [...r]));
  }

  private parse(range: string) {
    const m = range.match(/^'((?:[^']|'')+)'!(.+)$/);
    if (!m) throw new Error(`Неизвестный диапазон: ${range}`);
    const sheet = m[1].replace(/''/g, "'");
    const part = m[2];
    let r;
    if ((r = part.match(/^(\d+):(\d+)$/))) return { sheet, r1: +r[1] - 1, r2: +r[2] - 1, c1: 0, c2: Infinity };
    if ((r = part.match(/^([A-Z]+)(\d+):([A-Z]+)$/))) return { sheet, r1: +r[2] - 1, r2: Infinity, c1: colToIndex(r[1]), c2: colToIndex(r[3]) };
    if ((r = part.match(/^([A-Z]+):([A-Z]+)$/))) return { sheet, r1: 0, r2: Infinity, c1: colToIndex(r[1]), c2: colToIndex(r[2]) };
    if ((r = part.match(/^([A-Z]+)(\d+)$/))) return { sheet, r1: +r[2] - 1, r2: +r[2] - 1, c1: colToIndex(r[1]), c2: colToIndex(r[1]) };
    throw new Error(`Неизвестный диапазон: ${range}`);
  }

  async getValues(range: string): Promise<string[][]> {
    const { sheet, r1, r2, c1, c2 } = this.parse(range);
    const grid = this.grids.get(sheet) ?? [];
    const rows: string[][] = [];
    for (let r = r1; r <= Math.min(r2, grid.length - 1); r++) {
      const row = grid[r] ?? [];
      const cells = row.slice(c1, c2 === Infinity ? undefined : c2 + 1);
      while (cells.length > 0 && !cells[cells.length - 1]) cells.pop();
      rows.push(cells);
    }
    while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
    return rows;
  }

  async batchUpdate(updates: { range: string; values: (string | number)[][] }[]): Promise<void> {
    if (this.failWrites) throw new Error("Google API: 503 backendError");
    let lastSheet = "";
    let lastRow = 0;
    for (const u of updates) {
      const { sheet, r1, c1 } = this.parse(u.range);
      const grid = this.grids.get(sheet) ?? [];
      while (grid.length <= r1) grid.push([]);
      while (grid[r1].length <= c1) grid[r1].push("");
      // USER_ENTERED: ведущий апостроф — признак текста и в ячейку не попадает
      grid[r1][c1] = String(u.values[0][0]).replace(/^'/, "");
      this.grids.set(sheet, grid);
      this.writes.push({ sheet, row: r1 + 1, col: c1, value: grid[r1][c1] });
      lastSheet = sheet;
      lastRow = r1 + 1;
    }
    this.afterWrite?.(lastSheet, lastRow);
  }

  cell(sheet: string, row: number, colLetterIdx: number): string {
    return this.grids.get(sheet)?.[row - 1]?.[colLetterIdx] ?? "";
  }
}
