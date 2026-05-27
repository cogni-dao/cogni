# syntax=docker/dockerfile:1.7-labs
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Base image – shared across stages
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.2 --activate

# Builder: full workspace install + build
# Cache efficiency relies on BuildKit pnpm-store mount (packages pre-fetched)
FROM base AS builder
RUN apk add --no-cache g++ make python3

# 1. Copy dependency manifests first (maximizes install layer caching)
#    --parents preserves directory structure with wildcards (BuildKit feature)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents nodes/operator/app/package.json ./
COPY --parents packages/*/package.json ./
COPY --parents nodes/*/app/package.json ./
COPY --parents nodes/*/packages/*/package.json ./

# Use official node dist to avoid unofficial-builds.nodejs.org flakiness
ENV npm_config_disturl=https://nodejs.org/dist

# 2. Install dependencies (cached when manifests unchanged)
#    --ignore-scripts: skip lifecycle hooks (postinstall, etc.) since sources aren't copied yet
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts

# Codex: stash platform binary for runner (standalone tracing misses it).
RUN ARCH=$(node -p "process.arch === 'x64' ? 'x64' : 'arm64'") && \
    mkdir -p /tmp/codex-native/@openai && \
    cp -rL "node_modules/.pnpm/@openai+codex@0.116.0-linux-${ARCH}/node_modules/@openai/codex" \
           "/tmp/codex-native/@openai/codex-linux-${ARCH}"

# 3. Copy full source (filtered by .dockerignore)
COPY . .

ARG APP_ENV=production

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    APP_ENV=${APP_ENV}

# Build all workspace packages (brute-force, not graph-scoped)
# Required: package exports point to dist/, must exist before Next.js build
# Uses canonical packages:build: tsup (JS) + tsc -b (declarations) + validation
RUN pnpm packages:build

# Build-time placeholder for AUTH_SECRET (required by env validation during Next.js page collection)
# Not a real secret; runtime containers must provide real AUTH_SECRET via deployment env
ARG AUTH_SECRET_BUILD="build-time-placeholder-min-32-chars-xxxxxxxxxxxxxxxx"
ENV AUTH_SECRET=${AUTH_SECRET_BUILD}

# Build the web app
RUN --mount=type=cache,id=next-cache,target=/app/nodes/operator/app/.next/cache,sharing=locked \
    pnpm --filter operator build

# Runner – lean production image
FROM node:22-alpine AS runner
WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && apk add --no-cache curl ripgrep git

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV LOG_FORMAT=json

LABEL org.opencontainers.image.title="cogni-template"

# Copy standalone bundle (includes production dependencies)
# outputFileTracingRoot=../../../ means standalone output mirrors monorepo structure
COPY --from=builder --chown=nextjs:nodejs /app/nodes/operator/app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/nodes/operator/app/.next/static ./nodes/operator/app/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/nodes/operator/app/public ./nodes/operator/app/public

# Repo-spec: node-specific DAO config (node_id, chain, governance).
# Each node MUST copy its own .cogni — NOT root (which is operator's identity).
COPY --from=builder --chown=nextjs:nodejs /app/nodes/operator/.cogni ./.cogni

# Codex CLI for BYO-AI ChatGPT execution.
# Standalone output tracing can't detect spawned binaries.
# Install globally so pnpm resolves platform-specific optional deps (@openai/codex-linux-x64).
ENV PNPM_HOME="/usr/local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.12.2 --activate && pnpm add -g @openai/codex@0.116.0 @openai/codex-sdk@0.116.0

# The global install has broken symlinks (pnpm v10 CAS). This COPY places the real
# platform binary where the SDK's createRequire chain finds it. See bug.0224.
COPY --from=builder --chown=nextjs:nodejs /tmp/codex-native/@openai/ ./node_modules/@openai/

# MCP server config — parseMcpConfigFromEnv reads config/mcp.servers.json relative to CWD.
# Next.js standalone does process.chdir(__dirname) → CWD becomes /app/nodes/operator/app at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/config/mcp.servers.json ./nodes/operator/app/config/mcp.servers.json

# Build SHA plumbing: CI passes --build-arg BUILD_SHA=${GITHUB_SHA}; app reads APP_BUILD_SHA at runtime.
# Placed last so cache invalidation from a new commit only rebuilds the trailing metadata layer,
# not the expensive upstream COPY + pnpm-add-codex layers.
# No default: if CI forgets to pass the arg, APP_BUILD_SHA is empty and the pod visibly reports it.
ARG BUILD_SHA
ENV APP_BUILD_SHA=$BUILD_SHA

USER nextjs

# Migrate runner — bundled into runtime image so Deployment initContainers can
# invoke `node migrate.mjs` directly. task.0370 step 1.
COPY --from=builder --chown=nextjs:nodejs /app/nodes/operator/app/src/adapters/server/db/migrations /app/nodes/operator/app/migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts/db/migrate.mjs /app/nodes/operator/app/migrate.mjs
# Doltgres migrate runner — task.0423: applies @cogni/operator-doltgres-schema
# migrations against `knowledge_operator`, then stamps a dolt_commit so DDL
# lands in dolt_log.
COPY --from=builder --chown=nextjs:nodejs /app/nodes/operator/app/src/adapters/server/db/doltgres-migrations /app/nodes/operator/app/doltgres-migrations
# Doltgres migrator + verifier — shared scripts (parity with the Postgres
# migrate.mjs COPY above). Verifier is sibling-imported by migrate-doltgres.mjs
# and runs the post-migrate schema check before any tracking-row stamping,
# closing the silent-skip gap from drizzle-orm's folderMillis-only "applied?"
# check.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/db/migrate-doltgres.mjs /app/nodes/operator/app/migrate-doltgres.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/db/verify-doltgres-schema.mjs /app/nodes/operator/app/verify-doltgres-schema.mjs

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/livez || exit 1

CMD ["node", "nodes/operator/app/server.js"]
