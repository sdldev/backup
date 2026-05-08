FROM oven/bun:1.3.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gzip \
    default-mysql-client \
    postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/app/package.json packages/app/package.json
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000
CMD ["bun", "--filter", "@backup-saas/app", "start"]
