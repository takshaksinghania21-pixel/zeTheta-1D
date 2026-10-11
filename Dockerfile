# syntax=docker/dockerfile:1.7
# Multi-stage build: compile TypeScript, then ship only production deps + dist.
# Runs as the unprivileged `node` user (uid 1000). Image tag pinned.

FROM node:20.19.6-bookworm-slim AS build
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY config ./config
COPY templates ./templates
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:20.19.6-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    METRICS_PORT=9464
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000 9464
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health/live" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
# Default: API. Workers: `node dist/src/workers/main.js <worker list|all>`
CMD ["node", "dist/src/server.js"]
