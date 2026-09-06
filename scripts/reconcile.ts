import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { reconcile } from '../src/lib/engine/reconcile';

/**
 * On-demand reconcile: `pnpm reconcile [days]`.
 * Re-scans the last N days of Twenty activity (default: settings.rules.reconcileLookbackDays)
 * and completes anything the webhooks missed. Safe to run repeatedly.
 */
async function main() {
  const arg = process.argv[2];
  const days = arg ? Number.parseInt(arg, 10) : undefined;
  if (arg && (!days || days < 1)) {
    console.error('usage: pnpm reconcile [days]');
    process.exit(2);
  }
  const stats = await reconcile({ days });
  console.log(JSON.stringify(stats, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
