import { NextResponse } from "next/server";
import { metaConfig } from "@/lib/config";
import { resolveChallenge, verifyMetaSignature } from "@/lib/integrations/meta";
import { createLogger, newRequestId } from "@/lib/logger";
import { getMetaIntakeDeps } from "@/lib/runtime";
import { processMetaPayload } from "@/lib/services/meta-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — рукопожатие при подписке вебхука в Meta for Developers.
export async function GET(req: Request) {
  const challenge = resolveChallenge(new URL(req.url).searchParams, metaConfig().META_VERIFY_TOKEN);
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

// POST — лид-формы (leadgen) и сообщения Instagram Direct. Подпись проверяется по СЫРОМУ телу.
export async function POST(req: Request) {
  const log = createLogger("meta-webhook", newRequestId());
  const raw = await req.text();

  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), metaConfig().META_APP_SECRET)) {
    log.warn("вебхук Meta отклонён: неверная подпись");
    return new NextResponse("invalid signature", { status: 403 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }

  void processMetaPayload(body, getMetaIntakeDeps())
    .then((stats) => log.info("событие Meta обработано", stats))
    .catch((err) => log.error("ошибка обработки события Meta", { message: err instanceof Error ? err.message : String(err) }));

  return NextResponse.json({ ok: true });
}
