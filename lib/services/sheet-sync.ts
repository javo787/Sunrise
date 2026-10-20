import { sheetsConfig } from "@/lib/config";
import { listSheetSyncCandidates, lockForSheetSync, markSheetFailed, markSheetSynced } from "@/lib/db/leads";
import type { Lead } from "@/lib/db/collections";
import { appendLeadRow, getSheetsApi, parseColumnOverrides, type SheetsApi } from "@/lib/integrations/sheets";
import { coreConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";

const log = createLogger("sheet-sync");

export type SyncOutcome = "synced" | "failed" | "skipped";

/**
 * Записывает закреплённый лид на персональный лист менеджера. Захват задачи атомарен
 * (lockForSheetSync), поэтому прямой вызов после клика и cron-повтор не продублируют строку.
 */
export async function syncLeadToSheet(lead: Pick<Lead, "_id">, api: SheetsApi = getSheetsApi(), now: Date = new Date()): Promise<SyncOutcome> {
  const cfg = sheetsConfig();
  const locked = await lockForSheetSync(lead._id, cfg.SHEETS_SYNC_MAX_ATTEMPTS, now);
  if (!locked || !locked.claim) return "skipped";

  try {
    const res = await appendLeadRow(
      api,
      locked.claim.sheetName,
      locked,
      {
        headerRow: cfg.SHEETS_HEADER_ROW,
        overrides: parseColumnOverrides(cfg.SHEETS_COLUMNS),
        tz: coreConfig().TIMEZONE,
        dateFormat: cfg.SHEETS_DATE_FORMAT,
      },
      now
    );
    await markSheetSynced(locked._id, { sheetName: locked.claim.sheetName, row: res.row }, now);
    log.info("лид записан в таблицу", { leadId: locked._id.toHexString(), sheet: locked.claim.sheetName, row: res.row, alreadyPresent: res.alreadyPresent });
    return "synced";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("не удалось записать лид в таблицу — повторит cron", { leadId: locked._id.toHexString(), message });
    await markSheetFailed(locked._id, message);
    return "failed";
  }
}

/** Cron: повторная запись лидов, которые не попали в таблицу (сбой API, квота, обрыв). */
export async function retryPendingSheetSyncs(api?: SheetsApi, now: Date = new Date()): Promise<{ synced: number; failed: number }> {
  const cfg = sheetsConfig();
  const candidates = await listSheetSyncCandidates(cfg.SHEETS_SYNC_MAX_ATTEMPTS, now);
  const sheets = api ?? getSheetsApi();
  const result = { synced: 0, failed: 0 };
  for (const lead of candidates) {
    const outcome = await syncLeadToSheet(lead, sheets, now);
    if (outcome === "synced") result.synced++;
    if (outcome === "failed") result.failed++;
  }
  return result;
}
