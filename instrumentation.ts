// Next.js вызывает register() один раз при старте сервера. Планировщик нужен только в
// долгоживущем Node-процессе (Render/VPS); ENABLE_INTERNAL_CRON=off отключает его, если
// задачи запускает внешний планировщик через /api/cron/[job].
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ENABLE_INTERNAL_CRON === "off") return;
  if (!process.env.MONGODB_URI) {
    console.warn("[scheduler] MONGODB_URI не задан — планировщик не запущен");
    return;
  }
  const { startScheduler } = await import("./lib/cron/scheduler");
  startScheduler();
}
