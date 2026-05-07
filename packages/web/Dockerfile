FROM oven/bun:1.3.5 AS deps

WORKDIR /workspace

COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/app/package.json packages/app/package.json
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.5 AS builder

WORKDIR /workspace

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /workspace/packages/app/node_modules ./packages/app/node_modules
COPY --from=deps /workspace/packages/web/node_modules ./packages/web/node_modules
COPY . .

RUN bun --filter @backup-saas/web typecheck
RUN bun --filter @backup-saas/web build

FROM oven/bun:1.3.5 AS runtime

WORKDIR /workspace
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

COPY --from=builder /workspace/package.json ./package.json
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /workspace/packages/shared/src ./packages/shared/src
COPY --from=builder /workspace/packages/web/package.json ./packages/web/package.json
COPY --from=builder /workspace/packages/web/node_modules ./packages/web/node_modules
COPY --from=builder /workspace/packages/web/dist ./packages/web/dist

EXPOSE 4321
CMD ["bun", "packages/web/dist/server/entry.mjs"]
