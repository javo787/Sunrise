// Планировщик нужен только в долгоживущем Node-процессе (Render/VPS). ENABLE_INTERNAL_CRON=off
// отключает его, если задачи запускает внешний планировщик через /api/cron/[job].
import { startScheduler } from "./lib/cron/scheduler";

if (process.env.ENABLE_INTERNAL_CRON === "off") {
  console.info("[scheduler] отключён (ENABLE_INTERNAL_CRON=off)");
} else if (!process.env.MONGODB_URI) {
  console.warn("[scheduler] MONGODB_URI не задан — планировщик не запущен");
} else {
  startScheduler();
}
