# Cadence - one image for both the web app and the worker.
# Built to fit a 1 vCPU / 2 GB server: the build is single-threaded with a heap ceiling, and
# type checking is expected to have run already (pnpm typecheck / CI).
FROM node:22-bookworm-slim AS base
ARG SKIP_TYPE_CHECK=false
ARG NEXT_BUILD_CPUS=1
# T03: corepack keeps pnpm in COREPACK_HOME, outside /root/.cache (which the build deletes), so a
# container starts with no network: it never has to download pnpm before it can migrate.
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_HOME=/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    SKIP_TYPE_CHECK=$SKIP_TYPE_CHECK \
    NEXT_BUILD_CPUS=$NEXT_BUILD_CPUS
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY prisma ./prisma
RUN pnpm prisma generate

COPY . .
# 1536 MB ceiling keeps the build inside a 2 GB box (with ~400 MB left for the OS and Postgres).
# T24: the app runs as the image's unprivileged `node` user; only Next's runtime cache (.next) and
# corepack's pnpm need to be writable by it.
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm build \
 # The server code must not need a dev dependency the prune is about to remove (14 Nov: postcss).
 && node scripts/check-server-requires.mjs \
 && pnpm prune --prod \
 && pnpm store prune \
 && rm -rf /root/.cache /root/.npm .git e2e .screens \
 && mkdir -p /pnpm \
 && chown -R node:node /app/.next /corepack /pnpm

USER node

# The entrypoint runs migrations, the seed and the worker, so prune must not have taken those
# away. Fail the build here rather than at container start. Run as `node`, as the containers are.
RUN node -e "require.resolve('next'); require.resolve('@prisma/client')" \
 && COREPACK_ENABLE_NETWORK=0 pnpm --version \
 && test -x node_modules/.bin/prisma \
 && test -f node_modules/tsx/dist/cli.mjs \
 && node --import tsx -e "0" \
 && test -f node_modules/next/dist/bin/next \
 && test -f .next/BUILD_ID \
 && test -w .next

EXPOSE 3000
CMD ["sh", "docker/entrypoint.sh", "web"]
