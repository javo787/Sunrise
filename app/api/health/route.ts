import { NextResponse } from "next/server";
import { coreConfig, isConfigured, llmConfig, mailConfig, metaConfig, sheetsConfig, telegramConfig } from "@/lib/config";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Публичная проверка живости. Секреты не раскрываются — только факт, что секция настроена.
export async function GET() {
  let mongo = false;
  try {
    await (await getDb()).command({ ping: 1 });
    mongo = true;
  } catch {
    mongo = false;
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
  const ok = mongo && configured.core && configured.telegram;
  return NextResponse.json({ ok, mongo, configured }, { status: ok ? 200 : 503 });
}
