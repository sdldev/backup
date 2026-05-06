# Manual Backup SaaS Beta

First-release manual-backup SaaS beta for agency teams. Stack: Bun monorepo, Astro web helpers, Elysia API, Bun worker, Postgres, encrypted logical Backups.

## v1 scope

- Manual Backups only.
- Supported engines: MySQL-family and PostgreSQL-family databases.
- Platform-managed Backup Storage only.
- Download and restore instructions only. Product does not execute restore into customer databases.
- OAuth sign-in with Google and GitHub only.

Out of scope for v1:

- Scheduled Backups.
- Email notifications or webhooks.
- BYOS / customer-managed Backup Storage surfaces.
- Restore execution APIs or buttons.

## Requirements

- Bun 1.3+
- Docker available for disposable Postgres test flows
- `APP_MASTER_KEY_V1` set to unpadded base64url that decodes to exactly 32 bytes

## Local development

1. Copy `.env.example` to local env file or export values in shell.
2. Set `APP_MASTER_KEY_V1`.
3. Install deps:

```sh
bun install --frozen-lockfile
```

4. Prepare test database schema when needed:

```sh
bun run db:migrate:test
bun run db:seed:test
```

## Environment variables

Minimum local variables:

- `APP_MASTER_KEY_V1` — required by API and worker startup/key unwrap.
- `TEST_DATABASE_URL` — optional override for disposable/local test database bootstrap.

Check `.env.example` for repo-supported defaults and placeholders.

## Commands

### Quality gates

```sh
bun run lint
bun run typecheck
bun test --reporter=dot
bun run test:security
bun run test:integration
bun run test:e2e
```

### Focused tests

```sh
bun run test:e2e -- accessibility-smoke
bun run test:e2e -- onboarding
bun run test:security -- tenant
bun run test:security -- downloads
```

### Test database helpers

```sh
bun run db:reset:test
bun run db:migrate:test
bun run db:seed:test
```

### Worker and ops helpers

```sh
bun run worker:reconcile -- --dry-run
```

Retention worker currently runs through test and integration harness coverage via `runRetentionWorker()` in `apps/worker/src/index.ts`. There is no separate root `worker:retention` CLI script yet, so do not document or rely on one locally.

## Notes

- Expected test noise: Postgres `drop schema ... cascade` NOTICE output and Bun `8x PARALLEL` label can appear even when commands exit 0.
- Source tree must stay free of generated `.js`, `.d.ts`, and `.map` artifacts inside `apps/*/src`, `packages/*/src`, `scripts`, and `tests`.
