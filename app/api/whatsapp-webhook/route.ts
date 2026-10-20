import { NextResponse } from "next/server";
import { createLogger, newRequestId } from "@/lib/logger";
import { getWhatsAppIntakeDeps } from "@/lib/runtime";
import { isEvolutionAuthorized, processEvolutionEvent } from "@/lib/services/whatsapp-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Evolution API → сюда. Отвечаем 200 сразу; разбор, дедупликация и ответ клиенту идут асинхронно
// (процесс долгоживущий, поэтому фоновая работа после ответа не обрывается).
export async function POST(req: Request) {
  const requestId = newRequestId();
  const log = createLogger("wa-webhook", requestId);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const url = new URL(req.url);
  const authorized = isEvolutionAuthorized({
    bodyApiKey: typeof (body as { apikey?: unknown })?.apikey === "string" ? (body as { apikey: string }).apikey : undefined,
    headerSecret: req.headers.get("x-webhook-secret"),
    querySecret: url.searchParams.get("secret"),
    webhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET || undefined,
    apiKey: process.env.EVOLUTION_API_KEY || undefined,
    production: process.env.NODE_ENV === "production",
  });
  if (!authorized) {
    log.warn("вебхук WhatsApp отклонён: неверный секрет");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // зависимости собираются внутри async: сбой конфигурации не должен превратить ответ в 500
  void (async () => processEvolutionEvent(body, getWhatsAppIntakeDeps()))()
    .then((result) => log.info("событие WhatsApp обработано", { result }))
    .catch((err) => log.error("ошибка обработки события WhatsApp", { message: err instanceof Error ? err.message : String(err) }));

  return NextResponse.json({ ok: true });
}
