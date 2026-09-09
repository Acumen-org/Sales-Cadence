import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';

/**
 * `pnpm db:reset` - empty the workspace back to a fresh install.
 *
 * Everything Cadence owns goes: campaigns, enrollments, tasks, touches, meetings, the cached copy
 * of Twenty's people and companies, pods, every user except the admin in `.env`, and the audit
 * trail. Settings and the sequences you have built are kept, because those are the work, not the
 * data. Nothing is written to Twenty - this only clears Cadence's own database.
 *
 * It refuses to run without `--yes` on a non-interactive terminal, and asks first on one.
 */
const TABLES = [
  'AuditLog',
  'TwentyWrite',
  'ActivityEvent',
  'EnrichmentRow',
  'EnrichmentBatch',
  'MeetingAttendee',
  'Meeting',
  'Touch',
  'Task',
  'Enrollment',
  'Campaign',
  'Session',
  'UserPod',
  'CompanyCache',
  'PersonCache',
  'Pod',
];

async function main() {
  const force = process.argv.includes('--yes');
  const adminEmail = env().ADMIN_EMAIL.toLowerCase();
  const [users, people, campaigns] = await Promise.all([
    prisma.user.count({ where: { email: { not: adminEmail } } }),
    prisma.personCache.count(),
    prisma.campaign.count(),
  ]);

  console.log('This empties the Cadence database:');
  console.log(`  ${campaigns} campaigns and everything they generated`);
  console.log(`  ${people} cached contacts and their companies`);
  console.log(`  ${users} accounts other than ${adminEmail}, and every pod`);
  console.log('Settings and sequences are kept. Twenty is not touched.');

  if (!force) {
    if (!process.stdin.isTTY) {
      console.error('\nRefusing to run unattended. Re-run with --yes if that is what you meant.');
      process.exitCode = 2;
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\nType RESET to continue: ');
    rl.close();
    if (answer.trim() !== 'RESET') {
      console.log('Nothing was changed.');
      return;
    }
  }

  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  const removed = await prisma.user.deleteMany({ where: { email: { not: adminEmail } } });
  console.log(`\nDone. ${removed.count} accounts removed; ${adminEmail} kept.`);
  console.log('Pods and contacts will reappear as Twenty syncs them.');
}

main()
  .catch((error) => {
    console.error('[reset] failed', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
