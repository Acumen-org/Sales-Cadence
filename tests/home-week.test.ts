import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { buildHome } from '@/lib/home-query';
import { myOwnershipCounts } from '@/lib/accounts-query';
import { weekRange } from '@/lib/dates';
import { enrollPeople } from '@/lib/engine';
import { completeTask } from '@/lib/engine/tasks';
import { resetDb, seedBasics, type Basics } from './helpers/db';

// 2026-09-08 is a Tuesday, so this week is Sun 6th to Sat 12th.
const TUESDAY = new Date('2026-09-08T10:00:00Z');

function sessionUser(
  u: { id: string; email: string; name: string; role: 'ADMIN' | 'SALES_LEADER' | 'SENIOR_FO' | 'JUNIOR_FO'; timezone: string; twentyMemberId: string | null; dailyCap: number | null },
  podIds: string[],
): SessionUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) };
}

describe('home', () => {
  let b: Basics;

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    // person-01 is Alisa's in the mock fixture, enrolled with her as the FO.
    await enrollPeople(
      { personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR },
      { now: TUESDAY },
    );
  });

  it('counts today, overdue and upcoming per channel, and people rather than tasks', async () => {
    const alisa = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    const home = await buildHome(alisa, TUESDAY);
    expect(home.today).toBe('2026-09-08');
    // Day 1 of the default sequence is one email and one LinkedIn connect, both for one person.
    expect(home.my.overdueTotal + home.my.todayTotal).toBe(2);
    expect(home.my.peopleToReachToday + (home.my.overdueTotal ? 1 : 0)).toBeGreaterThan(0);
  });

  it('labels the week Sunday to Saturday in the user timezone', async () => {
    const home = await buildHome(sessionUser(b.users.alisa, [b.pods.Alisa.id]), TUESDAY);
    expect([home.week.from, home.week.to]).toEqual(['2026-09-06', '2026-09-12']);
    expect(home.week.fromInstant).toEqual(weekRange('2026-09-08', 'Europe/London').fromInstant);
  });

  it('counts what a user owns: accounts and relationships', async () => {
    const alisa = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    const mine = await myOwnershipCounts(alisa);
    const owned = await prisma.personCache.count({ where: { deletedAt: null, ownerMemberId: 'wm-alisa' } });
    expect(mine.relationships).toBe(owned);
    expect(mine.accounts).toBeGreaterThan(0);

    // Owning an account with nobody in it still counts as an account.
    const empty = await prisma.companyCache.create({ data: { id: 'co-empty', name: 'Empty Co', ownerMemberId: 'wm-alisa' } });
    expect((await myOwnershipCounts(alisa)).accounts).toBe(mine.accounts + 1);
    await prisma.companyCache.delete({ where: { id: empty.id } });

    const home = await buildHome(alisa, TUESDAY);
    expect(home.my.accounts).toBe(mine.accounts);
    expect(home.my.relationships).toBe(mine.relationships);
  });

  it('reports the team board on this week, not a rolling window', async () => {
    // Finish one task inside this week and one before it.
    const tasks = await prisma.task.findMany({ where: { foUserId: b.users.alisa.id, state: 'PENDING' }, orderBy: { actionIndex: 'asc' } });
    await completeTask({ taskId: tasks[0].id, source: 'MANUAL' }, { actor: SYSTEM_ACTOR, now: TUESDAY });
    await prisma.task.update({ where: { id: tasks[1].id }, data: { state: 'DONE', completedAt: new Date('2026-08-30T10:00:00Z') } });

    const admin = sessionUser(b.users.ria, []);
    const home = await buildHome(admin, TUESDAY);
    const row = home.team.find((t) => t.id === b.users.alisa.id)!;
    expect(row.name).toBe('Alisa Marsh');
    expect(row.doneWeek).toBe(1); // the August one is last week
    expect(home.team.length).toBeGreaterThan(1); // admins see everyone
  });

  it('credits replies and meetings to the FO whose enrollment they belong to', async () => {
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01' } });
    await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { repliedAt: new Date('2026-09-09T09:00:00Z'), meetingAt: new Date('2026-09-10T14:00:00Z'), status: 'MEETING' },
    });
    const admin = sessionUser(b.users.ria, []);
    const home = await buildHome(admin, TUESDAY);
    const mine = home.team.find((t) => t.id === b.users.alisa.id)!;
    expect(mine.replies).toBe(1);
    expect(mine.meetings).toBe(1);
    // Nobody else gets the credit.
    expect(home.team.filter((t) => t.replies > 0)).toHaveLength(1);
  });

  // A junior leads nobody, so the board is their own week and nobody else's - not an empty card,
  // which left the Home screen of the role that uses this app most stopping half way down.
  it('gives a junior their own week and no colleagues', async () => {
    const home = await buildHome(sessionUser(b.users.karson, [b.pods.Alisa.id]), TUESDAY);
    expect(home.team.map((t) => t.id)).toEqual([b.users.karson.id]);
    expect(home.needsReview).toBe(0);
  });
});
