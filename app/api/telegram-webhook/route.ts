import { timingSafeEqual } from "node:crypto";
import { webhookCallback } from "grammy";
import { telegramConfig } from "@/lib/config";
import { getBot } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handler: ((req: Request) => Promise<Response>) | undefined;

function secretMatches(given: string | null, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Telegram → сюда. Секрет сверяем сами ДО передачи в grammY: чужой запрос не должен запускать
// инициализацию бота (она ходит во внешний API). При долгой обработке отвечаем 200 по таймауту,
// чтобы Telegram не слал обновление повторно (дубли всё равно отсекаются по update_id).
export async function POST(req: Request) {
  const secret = telegramConfig().TELEGRAM_WEBHOOK_SECRET;
  if (!secretMatches(req.headers.get("x-telegram-bot-api-secret-token"), secret)) {
    return new Response("unauthorized", { status: 401 });
  }
  handler ??= webhookCallback(getBot(), "std/http", {
    secretToken: secret,
    timeoutMilliseconds: 9_000,
    onTimeout: "return",
  });
  return handler(req);
}
