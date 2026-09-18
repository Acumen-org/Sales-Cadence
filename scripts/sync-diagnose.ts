import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';
import { getTwentyConnection } from '../src/lib/settings';
import { getTwentyClient } from '../src/lib/twenty';
import type { ContinuousSyncState } from '../src/lib/continuous-sync';

/**
 * `pnpm sync:diagnose`: why does the workspace not show what Twenty holds?
 *
 * Prints the connection, how many people and companies Twenty reports against how many are
 * cached, whether each listing Cadence depends on answers (people, companies, deleted people,
 * notes, messages, tasks, opportunities, members), and what the continuous sync recorded about
 * its last pass. Read-only. Exit code 1 when a listing fails or the cache is short.
 */
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function main() {
  const e = env();
  const conn = await getTwentyConnection();
  console.log(`Twenty mode: ${conn.mode}${conn.baseUrl ? ` (${conn.baseUrl})` : ''}${conn.dryRun ? ' [dry run: CADENCE_DRY_RUN=true, nothing is written to Twenty]' : ''}`);
  console.log(`Webhook auth: ${e.TWENTY_WEBHOOK_SECRET ? 'HMAC secret' : e.CADENCE_WEBHOOK_TOKEN ? 'shared token' : e.CADENCE_WEBHOOK_OPEN === '1' ? 'OPEN (deliberately)' : 'none - Twenty webhooks are refused with 401'}`);
  console.log(`Sync interval: every ${e.CRM_SYNC_SECONDS}s; nightly reconcile after ${e.RECONCILE_HOUR}:00\n`);
  if (conn.mode === 'graphql' && (!conn.baseUrl || !conn.apiKey)) {
    console.error('TWENTY_API_URL / TWENTY_API_KEY are not set (env or Settings > Twenty).');
    process.exit(2);
  }
  const client = await getTwentyClient();
  let problems = 0;

  const [twentyPeople, twentyCompanies, cachedPeople, cachedCompanies, deletedPeople] = await Promise.all([
    client.countRecords('person').catch(() => null),
    client.countRecords('company').catch(() => null),
    prisma.personCache.count({ where: { deletedAt: null } }),
    prisma.companyCache.count({ where: { deletedAt: null } }),
    prisma.personCache.count({ where: { deletedAt: { not: null } } }),
  ]);
  const line = (label: string, source: number | null, cached: number) => {
    const short = source !== null && cached < source;
    if (short) problems += 1;
    console.log(`${label.padEnd(10)} Twenty: ${source === null ? 'unknown' : String(source).padStart(6)}   cached: ${String(cached).padStart(6)}${short ? `   <-- ${source! - cached} missing` : ''}`);
  };
  line('People', twentyPeople, cachedPeople);
  line('Companies', twentyCompanies, cachedCompanies);
  console.log(`${'Deleted'.padEnd(10)} ${deletedPeople} people are marked deleted in the cache`);
  // Accounts counts people with a company; People counts everyone. The gap between them is people
  // Twenty holds with no company link, which this line makes a number rather than a worry.
  const [linked, unlinked] = await Promise.all([
    prisma.personCache.count({ where: { deletedAt: null, companyId: { not: null } } }),
    prisma.personCache.count({ where: { deletedAt: null, companyId: null } }),
  ]);
  console.log(`${'Accounts'.padEnd(10)} ${linked} cached people have a company, ${unlinked} have none`);
  if (process.argv.includes('--links')) {
    // Walk Twenty's people and count company links at the source: slow (one page of 100 at a
    // time), so only on request. A difference here is a sync fault; none means Twenty has no link.
    let sourceLinked = 0, sourceTotal = 0, after: string | undefined;
    for (;;) {
      const page = await client.listPeople({ limit: 100, after });
      for (const person of page.items) { sourceTotal += 1; if (person.companyId) sourceLinked += 1; }
      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }
    const short = sourceLinked > linked;
    if (short) problems += 1;
    console.log(`${'Links'.padEnd(10)} Twenty: ${sourceLinked} of ${sourceTotal} people have a company   cached: ${linked}${short ? `   <-- ${sourceLinked - linked} links missing` : ''}`);
  }
  console.log('');

  console.log('Listings (first page of each):');
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const checks: Array<[string, () => Promise<{ items: unknown[]; hasNextPage: boolean }>]> = [
    ['people', () => client.listPeople({ limit: 100, includeDeleted: true })],
    ['people changed in 7 days', () => client.listPeople({ updatedSince: since, limit: 100, includeDeleted: true })],
    ['people deleted in 7 days', () => client.listPeople({ deletedSince: since, limit: 100 })],
    ['companies', () => client.listCompanies({ limit: 100 })],
    ['companies deleted in 7 days', () => client.listCompanies({ deletedSince: since, limit: 100 })],
    ['notes', () => client.listNotes({ updatedSince: since, limit: 100 })],
    ['messages', () => client.listMessages({ updatedSince: since, limit: 100 })],
    ['tasks', () => client.listTasks({ updatedSince: since, limit: 100 })],
    ['opportunities', () => client.listOpportunities({ updatedSince: since, limit: 100 })],
    ['workspace members', async () => ({ items: await client.listWorkspaceMembers(), hasNextPage: false })],
  ];
  // The reads a person record makes, against a real person: these are the ones that fail when
  // Twenty renames a relation (note targets went from personId to targetPersonId).
  const sample = await prisma.personCache.findFirst({ where: { deletedAt: null, email: { not: null } }, select: { id: true }, orderBy: { syncedAt: 'desc' } });
  if (sample) {
    checks.push(
      ['notes for one person', () => client.listNotes({ personId: sample.id, limit: 20 })],
      ['messages for one person', () => client.listMessages({ personId: sample.id, limit: 20 })],
      ['tasks for one person', () => client.listTasks({ personId: sample.id, limit: 20 })],
      ['opportunities for one person', () => client.listOpportunities({ personId: sample.id, limit: 20 })],
      ['one person by id', async () => ({ items: [await client.getPerson(sample.id)].filter(Boolean), hasNextPage: false })],
    );
  }
  for (const [label, run] of checks) {
    try {
      const page = await run();
      console.log(`  ok   ${label.padEnd(30)} ${page.items.length} on the first page${page.hasNextPage ? ', more pages follow' : ''}`);
    } catch (err) {
      problems += 1;
      console.log(`  FAIL ${label.padEnd(30)} ${errorText(err)}`);
    }
  }
  if ('describeTargets' in client && typeof (client as { describeTargets?: unknown }).describeTargets === 'function') {
    const targets = await (client as unknown as { describeTargets(): Promise<{ noteTarget: { personId: string }; taskTarget: { personId: string } }> }).describeTargets();
    console.log(`
Target fields in this workspace: noteTarget.${targets.noteTarget.personId}, taskTarget.${targets.taskTarget.personId}`);
  }

  const state = (await prisma.setting.findUnique({ where: { key: 'continuousSync' } }))?.value as ContinuousSyncState | null;
  console.log('\nContinuous sync:');
  if (!state) console.log('  never ran - is the worker container up? (docker compose ps)');
  else {
    console.log(`  last success:      ${state.lastSuccess ?? 'never'}`);
    console.log(`  watermark:         ${state.watermark ?? 'none (the first full refresh has not completed)'}`);
    console.log(`  last full refresh: ${state.lastFullRefresh ?? 'never'}`);
    if (state.lastError) console.log(`  last error:        ${state.lastError}${state.attemptedAt ? ` (at ${state.attemptedAt})` : ''}`);
    for (const [stage, message] of Object.entries(state.stageErrors ?? {})) console.log(`  stage ${stage}: ${message}`);
    if (state.needsReview) console.log(`  ${state.needsReview} CRM events need review (Settings > Activity log)`);
    if (state.lastRun) console.log(`  last pass: ${JSON.stringify(state.lastRun)}`);
    if (state.lastError || Object.keys(state.stageErrors ?? {}).length) problems += 1;
  }
  const failedWrites = await prisma.twentyWrite.count({ where: { status: 'FAILED' } });
  if (failedWrites) console.log(`\n${failedWrites} writes to Twenty are waiting to be retried (Settings > Activity log).`);
  console.log(problems ? `\n${problems} problem${problems === 1 ? '' : 's'} found.` : '\nNo problems found.');
  await prisma.$disconnect();
  process.exit(problems ? 1 : 0);
}

main().catch(async (err) => {
  console.error(errorText(err));
  await prisma.$disconnect();
  process.exit(2);
});
