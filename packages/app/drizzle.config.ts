import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://backup_saas:backup_saas@localhost:5432/backup_saas',
  },
  strict: true,
  verbose: true,
});
