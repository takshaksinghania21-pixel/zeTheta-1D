# syntax=docker/dockerfile:1.7
# Multi-stage build: compile TypeScript, then ship only production deps + dist.
# Alpine base keeps the image under the PDF Day 14 target of 200 MB (all
# dependencies are pure JavaScript, so no native rebuild is needed).
# Runs as the unprivileged `node` user (uid 1000). Node version pinned.

FROM node:20.19.6-alpine AS build
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

FROM node:20.19.6-alpine AS production
ENV NODE_ENV=production \
    PORT=3000 \
    METRICS_PORT=9464
WORKDIR /app
# tini reaps zombies and forwards signals (graceful shutdown); npm/yarn are not
# needed at runtime (services start with `node`), so they are removed.
RUN apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
      /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000 9464
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" > /dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Default: API. Workers: `node dist/src/workers/main.js <worker list|all>`
CMD ["node", "dist/src/server.js"]
