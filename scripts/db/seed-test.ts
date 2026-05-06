import { seedPlans } from "../../packages/db/src/testing";
import { ensureTestDatabase } from "./_test-db";

const databaseUrl = await ensureTestDatabase();

await seedPlans(databaseUrl);

console.log(`db:seed:test OK ${databaseUrl}`);
