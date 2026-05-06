import { ensureTestDatabase, resetPublicSchema } from "./_test-db";

const databaseUrl = await ensureTestDatabase();

await resetPublicSchema(databaseUrl);

console.log(`db:reset:test OK ${databaseUrl}`);
