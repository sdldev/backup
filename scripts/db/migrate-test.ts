import { applySqlFile } from "../../packages/db/src/testing";
import { ensureTestDatabase } from "./_test-db";

const databaseUrl = await ensureTestDatabase();

await applySqlFile("0001_initial.sql", databaseUrl);

console.log(`db:migrate:test OK ${databaseUrl}`);
