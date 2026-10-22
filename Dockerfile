# Sunrise CRM — образ для своего сервера (VPS) и любого Docker-хостинга.
# Сборка: docker build -t sunrise-crm .   Запуск: docker compose up -d  (см. docker-compose.yml)

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
# Типы проверяет CI (npm run typecheck); в образе проверка отключена ради скорости и памяти.
RUN SKIP_TYPECHECK=1 NEXT_TELEMETRY_DISABLED=1 npm run build

FROM node:20-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/next.config.js ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start"]
