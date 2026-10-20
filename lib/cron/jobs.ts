import { coreConfig, isConfigured, sheetsConfig } from "@/lib/config";
import { isLastDayOfMonth } from "@/lib/domain/time";
import { getMetaIntakeDeps, getPipelineDeps, getReportDeps } from "@/lib/runtime";
import { escalateStaleLeads, publishPendingLeads } from "@/lib/services/lead-pipeline";
import { retryFailedLeadgens } from "@/lib/services/meta-intake";
import { sendReport } from "@/lib/services/reports";
import { retryPendingSheetSyncs } from "@/lib/services/sheet-sync";

// Фоновые задачи. Одни и те же функции запускает и node-cron (instrumentation.ts), и HTTP-эндпоинт
// /api/cron/[job] — на случай, если процесс перезапускается или нужен внешний планировщик.

export type JobOptions = { force?: boolean };

export const JOBS = {
  /** каждую минуту: досылаем неопубликованные карточки и тегаем менеджеров по лидам старше 15 минут */
  "publish-and-escalate": async () => {
    const deps = getPipelineDeps();
    const published = await publishPendingLeads(deps.gateway);
    const escalated = await escalateStaleLeads(deps);
    return { published, escalated };
  },
  /** каждые 5 минут: повторная запись в таблицу и повтор лид-форм Meta, которые не удалось получить */
  "retry-failed": async () => {
    const sheets = isConfigured(sheetsConfig) ? await retryPendingSheetSyncs() : "sheets_not_configured";
    const meta = await retryFailedLeadgens(getMetaIntakeDeps());
    return { sheets, meta };
  },
  "report-daily": async () => ({ result: await sendReport("daily", new Date(), getReportDeps()) }),
  "report-monthly": async (opts: JobOptions = {}) => {
    const now = new Date();
    if (!opts.force && !isLastDayOfMonth(now, coreConfig().TIMEZONE)) return { result: "not_last_day" };
    return { result: await sendReport("monthly", now, getReportDeps()) };
  },
} as const;

export type JobName = keyof typeof JOBS;

export const isJobName = (name: string): name is JobName => Object.prototype.hasOwnProperty.call(JOBS, name);
