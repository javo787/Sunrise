/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // На бесплатном Render (512 МБ) проверку типов при сборке отключаем: типы строго проверяются в CI
  // (npm run typecheck). Локально и в CI SKIP_TYPECHECK не задаётся — проверка остаётся включённой.
  typescript: { ignoreBuildErrors: process.env.SKIP_TYPECHECK === "1" },
  experimental: {
    // instrumentation.ts запускает node-cron при старте долгоживущего Node-процесса
    instrumentationHook: true,
    serverComponentsExternalPackages: ["@googleapis/sheets", "google-auth-library", "nodemailer", "mongodb", "node-cron"],
  },
};
module.exports = nextConfig;
