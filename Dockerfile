# Cadence - single image used for both the web app and the worker.
FROM node:20-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
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
RUN pnpm build

EXPOSE 3000
CMD ["sh", "docker/entrypoint.sh", "web"]
