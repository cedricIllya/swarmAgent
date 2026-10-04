# Control plane. Собирается из корня монорепо: fly deploy (см. fly.toml).
FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @swarm/web...
# Портативная папка с postgres/drizzle для release_command, без tsx и без всего монорепо.
RUN pnpm --filter @swarm/db deploy --prod /out/db

FROM deps AS build
COPY apps/web apps/web
COPY agent-template agent-template
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @swarm/web build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 SKILL_TEMPLATE_DIR=/app/agent-template
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/agent-template ./agent-template
COPY --from=deps /out/db /migrate
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
