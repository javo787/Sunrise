import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
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
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, error: "CRON_SECRET не задан" }, { status: 503 });
  if (!authorized(req, secret)) return NextResponse.json({ ok: false }, { status: 401 });
  if (!isJobName(params.job)) return NextResponse.json({ ok: false, error: "unknown_job", jobs: Object.keys(JOBS) }, { status: 404 });

  const query = new URL(req.url).searchParams;
  const force = query.get("force") === "1";

  // async=1: ответить сразу, а работу выполнить в фоне. Нужно внешним планировщикам с коротким
  // таймаутом (у бесплатного cron-job.org он 30 с), а задачи вроде retry-failed могут идти дольше.
  if (query.get("async") === "1") {
    const job = params.job;
    void (async () => JOBS[job]({ force }))().catch((err) =>
      log.error("фоновая задача по HTTP завершилась ошибкой", { job, message: err instanceof Error ? err.message : String(err) })
    );
    return NextResponse.json({ ok: true, job, accepted: true }, { status: 202 });
  }

  try {
    const result = await JOBS[params.job]({ force });
    return NextResponse.json({ ok: true, job: params.job, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("задача по HTTP завершилась ошибкой", { job: params.job, message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export { run as GET, run as POST };
