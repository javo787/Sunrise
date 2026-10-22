import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Пульс: всегда 200 и не трогает ни БД, ни конфигурацию. Для health-check Render и внешних
// «будильников» (cron-job.org, UptimeRobot и т.п.). Если бы проверкой служил /api/health, то при
// кратковременном сбое MongoDB он отвечал бы 503, и Render начал бы перезапускать сервис.
// /api/health остаётся для диагностики (показывает, что настроено и жива ли БД).
export function GET() {
  return NextResponse.json({ status: "ok", service: "sunrise-crm", uptime: `${Math.round(process.uptime())}s` });
}
