# Cadence - one image for both the web app and the worker.
# Built to fit a 1 vCPU / 2 GB server: the build is single-threaded with a heap ceiling, and
# type checking is expected to have run already (pnpm typecheck / CI).
FROM node:20-bookworm-slim AS base
ARG SKIP_TYPE_CHECK=false
ARG NEXT_BUILD_CPUS=1
ENV NEXT_TELEMETRY_DISABLED=1 \
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
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm build \
 && pnpm prune --prod \
 && pnpm store prune \
 && rm -rf /root/.cache /root/.npm .git e2e .screens

# The entrypoint runs migrations, the seed and the worker, so prune must not have taken those
# away. Fail the build here rather than at container start.
RUN node -e "require.resolve('next'); require.resolve('@prisma/client')" \
 && test -x node_modules/.bin/prisma \
 && test -f node_modules/tsx/dist/cli.mjs \
 && test -f .next/BUILD_ID

EXPOSE 3000
CMD ["sh", "docker/entrypoint.sh", "web"]
