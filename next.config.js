/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  experimental: {
    // instrumentation.ts запускает node-cron при старте долгоживущего Node-процесса
    instrumentationHook: true,
    serverComponentsExternalPackages: ["googleapis", "nodemailer", "mongodb", "node-cron"],
  },
};
module.exports = nextConfig;
