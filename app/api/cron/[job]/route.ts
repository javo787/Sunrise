import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { coreConfig } from "@/lib/config";
import { isJobName, JOBS } from "@/lib/cron/jobs";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("cron-api");

function authorized(req: Request, secret: string): boolean {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const given = Buffer.from(req.headers.get("x-cron-secret") ?? bearer ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function run(req: Request, { params }: { params: { job: string } }) {
  const secret = coreConfig().CRON_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "CRON_SECRET не задан" }, { status: 503 });
  if (!authorized(req, secret)) return NextResponse.json({ ok: false }, { status: 401 });
  if (!isJobName(params.job)) return NextResponse.json({ ok: false, error: "unknown_job", jobs: Object.keys(JOBS) }, { status: 404 });

  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const result = await JOBS[params.job]({ force });
    return NextResponse.json({ ok: true, job: params.job, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("задача по HTTP завершилась ошибкой", { job: params.job, message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export { run as GET, run as POST };
