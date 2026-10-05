# Собирается из корня монорепо:
#   docker build -f apps/agent-runtime/Dockerfile -t registry.fly.io/swarm-agent-runtime:latest .
FROM node:24-alpine AS base
# Свой браузер агента. Stagehand не привозит Chrome сам.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont \
  && corepack enable && corepack prepare pnpm@10 --activate
ENV CHROME_PATH=/usr/bin/chromium
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/hermes-config/package.json packages/hermes-config/
COPY packages/usage/package.json packages/usage/
COPY apps/agent-runtime/package.json apps/agent-runtime/

RUN pnpm install --frozen-lockfile --filter @swarm/agent-runtime...

COPY packages/contracts packages/contracts
COPY packages/hermes-config packages/hermes-config
COPY packages/usage packages/usage
COPY apps/agent-runtime apps/agent-runtime

ENV NODE_ENV=production PORT=8787 DATA_DIR=/opt/data
EXPOSE 8787
WORKDIR /app/apps/agent-runtime
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
