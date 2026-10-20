import cron from "node-cron";
import { coreConfig } from "@/lib/config";
import { ensureIndexes } from "@/lib/db/collections";
import { createLogger } from "@/lib/logger";
import { JOBS, type JobName } from "./jobs";

const log = createLogger("scheduler");

// Расписание (часовой пояс из TIMEZONE, по умолчанию Asia/Dushanbe):
//   каждую минуту   — публикация карточек и эскалация через 15 минут
//   каждые 5 минут  — повтор записи в таблицу и лид-форм Meta
//   ежедневно 20:00 — дневной отчёт
//   28–31 числа 20:30 — месячный отчёт (отправляется только в последний день месяца)

const SCHEDULE: { name: JobName; expr: string }[] = [
  { name: "publish-and-escalate", expr: "* * * * *" },
  { name: "retry-failed", expr: "*/5 * * * *" },
  { name: "report-daily", expr: "0 20 * * *" },
  { name: "report-monthly", expr: "30 20 28-31 * *" },
];

const running = new Set<JobName>();
let started = false;

export async function runJob(name: JobName): Promise<void> {
  if (running.has(name)) {
    log.warn("предыдущий запуск задачи ещё идёт — пропускаем", { job: name });
    return;
  }
  running.add(name);
  try {
    const result = await JOBS[name]();
    log.info("задача выполнена", { job: name, result });
  } catch (err) {
    log.error("задача завершилась ошибкой", { job: name, message: err instanceof Error ? err.message : String(err) });
  } finally {
    running.delete(name);
  }
}

export function startScheduler(): void {
  if (started) return;
  started = true;
  const tz = coreConfig().TIMEZONE;

  ensureIndexes().catch((err) => log.error("не удалось создать индексы MongoDB", { message: err instanceof Error ? err.message : String(err) }));

  for (const { name, expr } of SCHEDULE) {
    cron.schedule(expr, () => void runJob(name), { timezone: tz });
  }
  log.info("планировщик запущен", { timezone: tz, jobs: SCHEDULE.map((j) => `${j.name} [${j.expr}]`) });
}
