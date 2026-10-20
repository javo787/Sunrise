import type { Lead } from "@/lib/db/collections";
import { claimReportSlot, releaseReportSlot } from "@/lib/db/events";
import { listLeadsCreatedBetween } from "@/lib/db/leads";
import { dateKey, monthKey, zonedParts, zonedStartOfDay, zonedStartOfMonth, zonedStartOfNextDay } from "@/lib/domain/time";
import type { ReportMail } from "@/lib/integrations/mail";
import { createLogger } from "@/lib/logger";
import { esc } from "@/lib/telegram/cards";

const log = createLogger("reports");

export type ReportKind = "daily" | "monthly";

export interface ManagerStat {
  managerId: number;
  name: string;
  sheetName: string;
  claimed: number;
  avgClaimMinutes: number | null;
}

export interface SourceStat {
  source: string;
  total: number;
  claimed: number;
}

export interface Report {
  kind: ReportKind;
  label: string;
  period: string;
  from: Date;
  to: Date;
  total: number;
  claimed: number;
  pending: number;
  escalated: number;
  sheetFailed: number;
  avgClaimMinutes: number | null;
  byManager: ManagerStat[];
  bySource: SourceStat[];
}

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmtMin = (m: number | null) => (m === null ? "—" : `${(Math.round(m * 10) / 10).toString().replace(".", ",")} мин`);

/** Время до захвата считается только для лидов, прошедших через группу (у ручных лидов публикации нет). */
function claimMinutes(lead: Lead): number | null {
  if (!lead.claim || !lead.publishedAt) return null;
  return Math.max(0, (lead.claim.at.getTime() - lead.publishedAt.getTime()) / 60_000);
}

export function aggregateReport(leads: Lead[], meta: Pick<Report, "kind" | "label" | "period" | "from" | "to">): Report {
  const managers = new Map<number, { stat: ManagerStat; times: number[] }>();
  const sources = new Map<string, SourceStat>();
  const allTimes: number[] = [];

  for (const lead of leads) {
    const s = sources.get(lead.source) ?? { source: lead.source, total: 0, claimed: 0 };
    s.total++;
    if (lead.status === "claimed") s.claimed++;
    sources.set(lead.source, s);

    if (lead.claim) {
      const m = managers.get(lead.claim.managerId) ?? {
        stat: { managerId: lead.claim.managerId, name: lead.claim.managerName, sheetName: lead.claim.sheetName, claimed: 0, avgClaimMinutes: null },
        times: [],
      };
      m.stat.claimed++;
      const t = claimMinutes(lead);
      if (t !== null) {
        m.times.push(t);
        allTimes.push(t);
      }
      managers.set(lead.claim.managerId, m);
    }
  }

  return {
    ...meta,
    total: leads.length,
    claimed: leads.filter((l) => l.status === "claimed").length,
    pending: leads.filter((l) => l.status === "pending").length,
    escalated: leads.filter((l) => l.escalatedAt).length,
    sheetFailed: leads.filter((l) => l.status === "claimed" && l.sheet.status === "failed").length,
    avgClaimMinutes: mean(allTimes),
    byManager: [...managers.values()]
      .map(({ stat, times }) => ({ ...stat, avgClaimMinutes: mean(times) }))
      .sort((a, b) => b.claimed - a.claimed || a.name.localeCompare(b.name)),
    bySource: [...sources.values()].sort((a, b) => b.total - a.total || a.source.localeCompare(b.source)),
  };
}

export async function buildReport(kind: ReportKind, now: Date, tz: string): Promise<Report> {
  const to = zonedStartOfNextDay(now, tz);
  const from = kind === "daily" ? zonedStartOfDay(now, tz) : zonedStartOfMonth(now, tz);
  const p = zonedParts(now, tz);
  const label =
    kind === "daily"
      ? `${String(p.day).padStart(2, "0")}.${String(p.month).padStart(2, "0")}.${p.year}`
      : `${MONTHS[p.month - 1]} ${p.year}`;
  const leads = await listLeadsCreatedBetween(from, to);
  return aggregateReport(leads, { kind, label, period: kind === "daily" ? dateKey(now, tz) : monthKey(now, tz), from, to });
}

const title = (r: Report) => `Отчёт за ${r.kind === "daily" ? "день" : "месяц"} — ${r.label}`;

const summaryLine = (r: Report) => `Лидов: ${r.total} · забрано: ${r.claimed} · ждут менеджера: ${r.pending} · эскалаций: ${r.escalated}`;
const avgLine = (r: Report) => `Среднее время до захвата: ${fmtMin(r.avgClaimMinutes)}`;
const managerLines = (r: Report) =>
  r.byManager.length ? r.byManager.map((m) => `• ${m.name} (${m.sheetName}) — ${m.claimed}, в среднем ${fmtMin(m.avgClaimMinutes)}`) : ["• нет данных"];
const sourceLines = (r: Report) =>
  r.bySource.length ? r.bySource.map((s) => `• ${s.source} — ${s.total} (забрано ${s.claimed})`) : ["• нет данных"];
const sheetWarning = (r: Report) => `⚠️ Не записано в таблицу: ${r.sheetFailed}`;

function textLines(r: Report): string[] {
  return [
    summaryLine(r),
    avgLine(r),
    "",
    "Менеджеры:",
    ...managerLines(r),
    "",
    "Источники:",
    ...sourceLines(r),
    ...(r.sheetFailed > 0 ? ["", sheetWarning(r)] : []),
  ];
}

export function renderReportTelegram(r: Report): string {
  return [
    `📊 <b>${esc(title(r))}</b>`,
    esc(summaryLine(r)),
    `⏱ ${esc(avgLine(r))}`,
    "",
    "👥 <b>Менеджеры</b>",
    ...managerLines(r).map(esc),
    "",
    "📍 <b>Источники</b>",
    ...sourceLines(r).map(esc),
    ...(r.sheetFailed > 0 ? ["", esc(sheetWarning(r))] : []),
  ].join("\n");
}

export function renderReportEmail(r: Report): ReportMail {
  const td = "style=\"padding:4px 10px;border:1px solid #ddd\"";
  const rows = (items: string[][]) => items.map((cells) => `<tr>${cells.map((c) => `<td ${td}>${esc(c)}</td>`).join("")}</tr>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
<h2>Sunrise CRM — ${esc(title(r))}</h2>
<p>Лидов: <b>${r.total}</b> · забрано: <b>${r.claimed}</b> · ждут менеджера: <b>${r.pending}</b> · эскалаций: <b>${r.escalated}</b><br>Среднее время до захвата: <b>${esc(fmtMin(r.avgClaimMinutes))}</b></p>
<h3>Менеджеры</h3><table style="border-collapse:collapse">${rows([["Менеджер", "Лист", "Забрал", "Среднее время"], ...r.byManager.map((m) => [m.name, m.sheetName, String(m.claimed), fmtMin(m.avgClaimMinutes)])])}</table>
<h3>Источники</h3><table style="border-collapse:collapse">${rows([["Источник", "Лидов", "Забрано"], ...r.bySource.map((s) => [s.source, String(s.total), String(s.claimed)])])}</table>
${r.sheetFailed > 0 ? `<p style="color:#b00">Не записано в таблицу: ${r.sheetFailed}</p>` : ""}
</div>`;
  return { subject: `Sunrise CRM: ${title(r)}`, text: [`Sunrise CRM — ${title(r)}`, "", ...textLines(r)].join("\n"), html };
}

export interface ReportDeps {
  tz: string;
  sendTelegram: (html: string) => Promise<void>;
  /** undefined — почта не настроена, отчёт уходит только в Telegram */
  sendEmail?: (mail: ReportMail) => Promise<void>;
}

/**
 * Собирает и рассылает отчёт. Слот периода занимается атомарно, поэтому при нескольких
 * инстансах или повторном запуске cron отчёт уйдёт один раз; если не доставлен никуда,
 * слот освобождается и отправка повторится.
 */
export async function sendReport(kind: ReportKind, now: Date, deps: ReportDeps, opts: { force?: boolean } = {}): Promise<"sent" | "skipped"> {
  const report = await buildReport(kind, now, deps.tz);
  if (!opts.force && !(await claimReportSlot(kind, report.period))) return "skipped";

  const jobs: Promise<void>[] = [deps.sendTelegram(renderReportTelegram(report))];
  if (deps.sendEmail) jobs.push(deps.sendEmail(renderReportEmail(report)));
  const results = await Promise.allSettled(jobs);

  results.forEach((r, i) => {
    if (r.status === "rejected") log.error(`отчёт не доставлен (${i === 0 ? "telegram" : "email"})`, { message: String(r.reason) });
  });
  if (results.every((r) => r.status === "rejected")) {
    if (!opts.force) await releaseReportSlot(kind, report.period).catch(() => undefined);
    throw new Error("Отчёт не доставлен ни в один канал");
  }
  return "sent";
}
