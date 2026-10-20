// Регистрирует вебхук Telegram: npm run setup:telegram
// Нужны TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET и PUBLIC_BASE_URL (https://ваш-домен).
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");

if (!token || !secret || !base) {
  console.error("Задайте TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET и PUBLIC_BASE_URL в .env.local");
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const set = await api("setWebhook", {
  url: `${base}/api/telegram-webhook`,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
});
console.log("setWebhook:", set.ok ? "ок" : set);

const info = await api("getWebhookInfo");
console.log("webhook:", info.result?.url, "| ожидает обновлений:", info.result?.pending_update_count, "| ошибка:", info.result?.last_error_message ?? "нет");
