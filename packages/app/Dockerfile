FROM oven/bun:1.3.5 AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gzip \
    default-mysql-client \
    postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

FROM base AS deps
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/app/package.json packages/app/package.json
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /workspace

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /workspace/packages/app/node_modules ./packages/app/node_modules
COPY package.json bun.lock ./
COPY packages/shared ./packages/shared
COPY packages/app ./packages/app

EXPOSE 3000
CMD ["bun", "--filter", "@backup-saas/app", "start"]
