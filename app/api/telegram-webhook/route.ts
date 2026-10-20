import { webhookCallback } from "grammy";
import { telegramConfig } from "@/lib/config";
import { getBot } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handler: ((req: Request) => Promise<Response>) | undefined;

// Telegram → сюда. secret_token сверяется внутри grammY; при долгой обработке отвечаем 200 по
// таймауту, чтобы Telegram не слал обновление повторно (дубли всё равно отсекаются по update_id).
export async function POST(req: Request) {
  handler ??= webhookCallback(getBot(), "std/http", {
    secretToken: telegramConfig().TELEGRAM_WEBHOOK_SECRET,
    timeoutMilliseconds: 9_000,
    onTimeout: "return",
  });
  return handler(req);
}
