import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { buildHome } from '@/lib/home-query';
import { accountDetail, listAccounts, myOwnershipCounts } from '@/lib/accounts-query';
import { listActivity } from '@/lib/activity-query';
import { listTasks } from '@/lib/tasks-query';
import { getTaskBrief } from '@/lib/brief';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { enrollPeople } from '@/lib/engine';
import { upsertCompanyCache } from '@/lib/person-cache';
import { MOCK_COMPANIES } from '@/lib/twenty/fixtures';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * The app has to be comfortable on one CPU, which means no page may issue a query per row.
 * This counts the statements each page's queries make, then adds a lot more data and checks the
 * count did not move. A regression to per-row lookups fails here rather than on the server.
 *
 * Counting needs PRISMA_LOG=events (tests/setup/setup-file.ts sets it); events are emitted, not
 * printed.
 */
type QueryEventClient = { $on: (event: 'query', cb: () => void) => void };

let seen = 0;
let armed = false;

async function countQueries(label: string, run: () => Promise<unknown>): Promise<number> {
  if (!armed) {
    (prisma as unknown as QueryEventClient).$on('query', () => {
      seen += 1;
    });
    armed = true;
  }
  seen = 0;
  await run();
  // Query events are delivered asynchronously; let the engine flush before reading the counter.
  await new Promise((r) => setTimeout(r, 50));
  const count = seen;
  console.log(`[query budget] ${label}: ${count}`);
  return count;
}

const sessionUser = (
  u: { id: string; email: string; name: string; role: 'ADMIN' | 'SALES_LEADER' | 'SENIOR_FO' | 'JUNIOR_FO'; timezone: string; twentyMemberId: string | null; dailyCap: number | null },
  podIds: string[],
): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) });

const NOW = new Date('2026-09-08T10:00:00Z');

describe('query budget per page', () => {
  let b: Basics;
  let admin: SessionUser;
  let alisa: SessionUser;
  let taskId: string;

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    for (const c of MOCK_COMPANIES) await upsertCompanyCache(c);
    admin = sessionUser(b.users.ria, []);
    alisa = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    await enrollPeople(
      { personIds: ['person-01', 'person-02', 'person-03'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR },
      { now: NOW },
    );
    taskId = (await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-01' } } })).id;
  });

  /** Every page, measured the same way twice: with a little data and with a lot. */
  const pages = () => ({
    'home (senior)': () => buildHome(alisa, NOW),
    'home (admin)': () => buildHome(admin, NOW),
    tasks: () => listTasks(alisa, { tab: 'today' }, NOW),
    // The task screen's right-hand panel: the heaviest read in the app, because it merges the
    // person, their history, the emails and notes Twenty holds, and the sequence's own events.
    'task brief': () => getTaskBrief(taskId, alisa),
    'accounts list': () => listAccounts(admin),
    'account detail': () => accountDetail('co-01', admin),
    'activity feed': () => listActivity({ limit: 60 }),
    'ownership tiles': () => myOwnershipCounts(alisa),
  });

  it('renders every page in a fixed handful of queries, whatever the row count', async () => {
    const before: Record<string, number> = {};
    for (const [label, run] of Object.entries(pages())) before[label] = await countQueries(`${label} (small)`, run);

    // The counter must actually be wired up, or this test would pass on zeros.
    expect(Math.min(...Object.values(before))).toBeGreaterThan(0);
    for (const [label, n] of Object.entries(before)) expect(n, `${label} issued ${n} queries`).toBeLessThan(30);

    // Now make the data big: everyone in a sequence, plenty of touches, meetings and audit rows.
    const people = await prisma.personCache.findMany({ where: { podOwner: 'ALISA' }, select: { id: true } });
    const toEnrol = people.map((p) => p.id).filter((id) => !['person-01', 'person-02', 'person-03'].includes(id));
    await enrollPeople({ personIds: toEnrol, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR }, { now: NOW });
    await prisma.touch.createMany({
      data: people.flatMap((p, i) =>
        [0, 1, 2].map((k) => ({
          personId: p.id,
          channel: 'EMAIL' as const,
          direction: k === 0 ? ('INBOUND' as const) : ('OUTBOUND' as const),
          occurredAt: new Date(NOW.getTime() - (k + 1) * 3_600_000),
          summary: `Touch ${i}-${k}`,
          externalId: `budget:${p.id}:${k}`,
          actorUserId: b.users.alisa.id,
        })),
      ),
    });
    for (const c of MOCK_COMPANIES.slice(0, 4)) {
      await prisma.meeting.create({
        data: {
          title: `Budget meeting ${c.id}`,
          provider: 'FILE',
          sourceUrl: 'https://files.example/x.mp4',
          occurredAt: new Date(NOW.getTime() - 7_200_000),
          companyId: c.id,
          companyName: c.name,
          createdById: b.users.alisa.id,
          attendees: { create: [{ email: 'someone@prospect.example', external: true }] },
        },
      });
    }

    const after: Record<string, number> = {};
    for (const [label, run] of Object.entries(pages())) after[label] = await countQueries(`${label} (large)`, run);

    // Going from empty to non-empty can add a query, because a section that had nothing to show
    // now has rows whose relations must be resolved. That is a one-off, not per-row growth, so
    // the real test is the next step: much more data again, and the count must not move.
    for (const [label, n] of Object.entries(after)) expect(n, `${label} issued ${n} queries`).toBeLessThan(30);

    await prisma.touch.createMany({
      data: people.flatMap((p, i) =>
        [3, 4, 5, 6, 7, 8].map((k) => ({
          personId: p.id,
          channel: 'EMAIL' as const,
          direction: k % 2 === 0 ? ('INBOUND' as const) : ('OUTBOUND' as const),
          occurredAt: new Date(NOW.getTime() - (k + 1) * 600_000),
          summary: `Touch ${i}-${k}`,
          externalId: `budget2:${p.id}:${k}`,
          actorUserId: b.users.alisa.id,
        })),
      ),
    });
    for (const c of MOCK_COMPANIES.slice(0, 4)) {
      for (const n of [1, 2, 3]) {
        await prisma.meeting.create({
          data: {
            title: `Budget meeting ${c.id} #${n}`,
            provider: 'FILE',
            sourceUrl: 'https://files.example/x.mp4',
            occurredAt: new Date(NOW.getTime() - n * 3_600_000),
            companyId: c.id,
            companyName: c.name,
            createdById: b.users.alisa.id,
            attendees: { create: [{ email: `p${n}@prospect.example`, external: true }] },
          },
        });
      }
    }

    const bigger: Record<string, number> = {};
    for (const [label, run] of Object.entries(pages())) bigger[label] = await countQueries(`${label} (larger)`, run);

    for (const label of Object.keys(after)) {
      expect(bigger[label], `${label}: ${after[label]} queries, then ${bigger[label]} with three times the rows`).toBe(after[label]);
    }
  });
});
