import { createDb } from './client';
import { plans } from './schema';

const GIB = 1024 ** 3;

const seedPlans = [
  {
    slug: 'basic' as const,
    name: 'Basic',
    databaseSourceLimit: 3,
    retainedStorageBytes: 10 * GIB,
    maxRetentionDays: 7,
    scheduledBackupsPerDay: 1,
    memberLimit: 2,
    manualBackupsPerSourcePerHour: 1,
    selfServe: true,
  },
  {
    slug: 'pro' as const,
    name: 'Pro',
    databaseSourceLimit: 20,
    retainedStorageBytes: 100 * GIB,
    maxRetentionDays: 30,
    scheduledBackupsPerDay: 5,
    memberLimit: 5,
    manualBackupsPerSourcePerHour: 5,
    selfServe: false,
  },
  {
    slug: 'agency' as const,
    name: 'Agency',
    databaseSourceLimit: 100,
    retainedStorageBytes: 1024 * GIB,
    maxRetentionDays: 30,
    scheduledBackupsPerDay: 5,
    memberLimit: 20,
    manualBackupsPerSourcePerHour: 10,
    selfServe: false,
  },
];

const db = createDb();

await db
  .insert(plans)
  .values(seedPlans)
  .onConflictDoUpdate({
    target: plans.slug,
    set: {
      name: plans.name,
      databaseSourceLimit: plans.databaseSourceLimit,
      retainedStorageBytes: plans.retainedStorageBytes,
      maxRetentionDays: plans.maxRetentionDays,
      scheduledBackupsPerDay: plans.scheduledBackupsPerDay,
      memberLimit: plans.memberLimit,
      manualBackupsPerSourcePerHour: plans.manualBackupsPerSourcePerHour,
      selfServe: plans.selfServe,
    },
  });

console.info('seeded plans');
process.exit(0);
