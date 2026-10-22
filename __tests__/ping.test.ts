import { GET } from "@/app/api/ping/route";

describe("/api/ping", () => {
  it("всегда отвечает 200 и не требует ни БД, ни конфигурации", async () => {
    for (const k of ["MONGODB_URI", "TELEGRAM_BOT_TOKEN", "CRON_SECRET"]) delete process.env[k];
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", service: "sunrise-crm" });
  });
});
