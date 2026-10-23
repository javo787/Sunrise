import { NextResponse } from "next/server";
import { coreConfig, isConfigured, llmConfig, mailConfig, metaConfig, sheetsConfig, telegramConfig } from "@/lib/config";
import { getDb } from "@/lib/mongodb";
import { configProblems, explainMongoError, explainWebhook, fetchTelegramState, sanitize } from "@/lib/services/diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Диагностика. Секреты не раскрываются: только факт «настроено/нет», названия неверных переменных
// и подсказки. ?deep=1 дополнительно спрашивает у Telegram состояние вебхука (для «бот молчит»).
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";

  let mongo = false;
  let mongoError: string | undefined;
  try {
    await (await getDb()).command({ ping: 1 });
    mongo = true;
  } catch (err) {
    mongoError = explainMongoError(sanitize(err instanceof Error ? err.message : String(err)));
  }

  const configured = {
    core: isConfigured(coreConfig),
    telegram: isConfigured(telegramConfig),
    meta: isConfigured(metaConfig),
    llm: isConfigured(llmConfig),
    sheets: isConfigured(sheetsConfig),
    mail: isConfigured(mailConfig),
    evolution: Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY),
  };
  // обязательные секции; остальные (meta, mail, evolution) могут быть не настроены осознанно
  const problems = configProblems({ core: coreConfig, telegram: telegramConfig }).map((m) => sanitize(m));
  const ok = mongo && configured.core && configured.telegram;

  const hints: string[] = [];
  const body: Record<string, unknown> = { ok, mongo, ...(mongoError ? { mongoError } : {}), configured, ...(problems.length ? { problems } : {}) };

  if (deep && configured.telegram) {
    const tg = telegramConfig();
    const state = await fetchTelegramState(tg.TELEGRAM_BOT_TOKEN, tg.TELEGRAM_API_ROOT);
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
    const expectedUrl = base ? `${base}/api/telegram-webhook` : undefined;
    body.telegram = {
      bot: state.username ? `@${state.username}` : undefined,
      error: state.error,
      webhookUrl: state.webhook?.url || null,
      pendingUpdates: state.webhook?.pending_update_count,
      lastError: state.webhook?.last_error_message,
      expectedUrl: expectedUrl ?? "PUBLIC_BASE_URL не задан",
    };
    if (state.error) hints.push(explainWebhook(null, expectedUrl, Date.now())[0], `Ответ Telegram: ${state.error}`);
    else hints.push(...explainWebhook(state.webhook ?? null, expectedUrl, Date.now()));
  }
  if (mongoError) hints.push(mongoError);
  if (hints.length > 0) body.hints = hints;

  return NextResponse.json(body, { status: ok ? 200 : 503 });
}
