# syntax=docker/dockerfile:1

# Node 22 matches what CI tests. node:sqlite loads unflagged on 22 (it prints an
# ExperimentalWarning), so the optional history-sync store needs no extra flags.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

# Manifests first so dependency installation caches independently of source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/backend/package.json apps/backend/
RUN pnpm install --frozen-lockfile --filter @echoflow/backend...

COPY packages/protocol packages/protocol
COPY apps/backend apps/backend
RUN pnpm --filter @echoflow/protocol build \
 && pnpm --filter @echoflow/backend build \
 && CI=true pnpm prune --prod \
 && CI=true pnpm install --frozen-lockfile --prod --filter @echoflow/backend... --offline
# `CI=true` forces pnpm past an interactive "reinstall from scratch?" prompt
# that a non-TTY `docker build` cannot answer (it otherwise silently no-ops,
# leaving devDependencies in place). Verified: on its own, `pnpm prune --prod`
# shrinks the shared .pnpm store correctly but also wipes EVERY local symlink
# under apps/backend/node_modules — including production deps (fastify, ws,
# the @echoflow/protocol workspace link) — a pnpm 10.0.0 bug with this
# filtered-install layout, not specific to this fallback; a bare `pnpm prune
# --prod` here crashes the server with ERR_MODULE_NOT_FOUND for
# @fastify/websocket. The follow-up `pnpm install --prod --offline` relinks
# from the now-pruned store: it recreates exactly the production symlinks
# (protocol included) and none of the devDependency ones, without touching
# the network (--offline fails loudly instead of silently refetching if
# anything is inconsistent).

FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.source=https://github.com/YmlyZA/echoflow
WORKDIR /app
# `pnpm deploy` requires inject-workspace-packages=true, which this workspace
# does not set (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE); the documented
# fallback is to copy the built workspace wholesale instead. Larger image,
# same behavior.
COPY --from=builder /app /app

ENV NODE_ENV=production \
    ECHOFLOW_HOST=0.0.0.0 \
    ECHOFLOW_PORT=8787

# Writable home for the optional history-sync SQLite file. /app is root-owned
# and the container runs as `node`, so `ECHOFLOW_HISTORY_DB=./echoflow-history.db`
# (what .env.example suggests) resolves to /app/... and makes DatabaseSync throw
# at server construction — the container exits at boot. Point the setting at
# /data instead and mount a volume there:
#   -v echoflow-data:/data -e ECHOFLOW_HISTORY_DB=/data/history.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8787

# Read the port from the environment rather than hardcoding it: ECHOFLOW_PORT is
# user-overridable, and a `-e ECHOFLOW_PORT=9000` container would otherwise be
# reported unhealthy forever.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ECHOFLOW_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/backend/dist/main.js"]
