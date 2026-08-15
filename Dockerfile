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
 && pnpm --filter @echoflow/backend build

FROM node:22-alpine AS runtime
WORKDIR /app
# `pnpm deploy` requires inject-workspace-packages=true, which this workspace
# does not set (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE); the documented
# fallback is to copy the built workspace wholesale instead. Larger image,
# same behavior.
COPY --from=builder /app /app

ENV NODE_ENV=production \
    ECHOFLOW_HOST=0.0.0.0 \
    ECHOFLOW_PORT=8787

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/backend/dist/main.js"]
