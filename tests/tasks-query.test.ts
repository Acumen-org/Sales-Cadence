import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { getTaskBrief } from '@/lib/brief';
import { enrollPeople, snoozeTask } from '@/lib/engine';
import { listTaskGroups } from '@/lib/tasks-query';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const at = (date: string) => new Date(`${date}T10:00:00Z`);

function sessionUser(u: { id: string; email: string; name: string; role: Role; timezone: string; twentyMemberId: string | null; dailyCap: number | null }, podIds: string[]): SessionUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) };
}

describe('tasks query and brief', () => {
  let b: Basics;
  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    // Alisa's pod: Alisa works person-01 (start Mon 7th), Karson works person-02 (start Wed 9th)
    await enrollPeople({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, { now: at('2026-09-07') });
    await enrollPeople({ personIds: ['person-02'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-09', assignment: { mode: 'FIXED', foUserId: b.users.karson.id }, actor: SYSTEM_ACTOR }, { now: at('2026-09-07') });
    // Leigh's pod: overdue since Thu 3rd
    await enrollPeople({ personIds: ['person-15'], sequenceId: b.sequence.id, podId: b.pods.Leigh.id, startDate: '2026-09-03', assignment: { mode: 'FIXED', foUserId: b.users.leigh.id }, actor: SYSTEM_ACTOR }, { now: at('2026-09-03') });
  });

  // A row is one step, not one task: the day-1 step is an email and a LinkedIn connect, and the
  // FO works them as one touchpoint. Every count on this screen is in that unit.
  it('classifies each step into today / overdue / upcoming by its earliest open touch', async () => {
    const admin = sessionUser(b.users.ria, []);
    const today = await listTaskGroups(admin, { tab: 'today' }, at('2026-09-07'));
    expect(today.today).toBe('2026-09-07');
    expect(today.rows.map((r) => r.enrollment.personId)).toEqual(['person-01']);
    expect(today.rows[0].childActions).toHaveLength(2);
    expect(today.counts).toEqual({ today: 1, overdue: 1, upcoming: 1, done: 0 });
    const overdue = await listTaskGroups(admin, { tab: 'overdue' }, at('2026-09-07'));
    expect(overdue.rows.every((r) => r.enrollment.personId === 'person-15')).toBe(true);
    const upcoming = await listTaskGroups(admin, { tab: 'upcoming' }, at('2026-09-07'));
    expect(upcoming.rows.every((r) => r.enrollment.personId === 'person-02')).toBe(true);
  });

  it('a step moves day only when every open touch on it has moved', async () => {
    const admin = sessionUser(b.users.ria, []);
    const [step] = (await listTaskGroups(admin, { tab: 'today' }, at('2026-09-07'))).rows;
    const [first, second] = step.childIds;

    // Snoozing one module leaves the step where it is: its sibling is still due today.
    await snoozeTask({ taskId: first, toDate: '2026-09-08' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    const partly = await listTaskGroups(admin, { tab: 'today' }, at('2026-09-07'));
    expect(partly.rows.map((r) => r.id)).toContain(second);

    // With both snoozed the whole step is tomorrow's work.
    await snoozeTask({ taskId: second, toDate: '2026-09-08' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    const none = await listTaskGroups(admin, { tab: 'today' }, at('2026-09-07'));
    expect(none.rows.some((r) => r.enrollment.personId === 'person-01')).toBe(false);
    const tomorrow = await listTaskGroups(admin, { tab: 'today' }, at('2026-09-08'));
    expect(tomorrow.rows.some((r) => r.enrollment.personId === 'person-01')).toBe(true);
  });

  it('scopes by role: junior sees own, senior sees pod, admin sees all', async () => {
    const all = (tab: 'today' | 'overdue' | 'upcoming') => tab;
    const junior = sessionUser(b.users.karson, [b.pods.Alisa.id]);
    const senior = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    const admin = sessionUser(b.users.ria, []);
    const now = at('2026-09-07');

    const j = await listTaskGroups(junior, { tab: all('upcoming') }, now);
    expect(j.rows.every((r) => r.foUserId === b.users.karson.id)).toBe(true);
    expect(j.counts.overdue).toBe(0); // Leigh's overdue work is invisible to Karson

    const s = await listTaskGroups(senior, { tab: all('upcoming') }, now);
    expect(s.rows.some((r) => r.foUserId === b.users.karson.id)).toBe(true); // pod colleague
    expect(s.counts.overdue).toBe(0); // other pod

    const a = await listTaskGroups(admin, { tab: all('overdue') }, now);
    expect(a.counts.overdue).toBe(1);
    const filtered = await listTaskGroups(admin, { tab: all('upcoming'), podId: b.pods.Alisa.id, foUserId: b.users.karson.id }, now);
    expect(filtered.rows.every((r) => r.foUserId === b.users.karson.id)).toBe(true);
  });

  it('builds the brief with the filled template, colleagues and next step', async () => {
    const senior = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01' }, include: { tasks: true } });
    const email1 = e.tasks.find((t) => t.label === 'Email 1')!;
    const brief = await getTaskBrief(email1.id, senior);
    expect(brief).not.toBeNull();
    expect(brief!.personName).toBe('Nina Halvorsen');
    // Copy is the module's own text, verbatim: no substitution, so no half-filled greeting.
    expect(brief!.action.subject).toBe('A quick idea for your team');
    expect(brief!.action.body).toContain('keep it short');
    expect(brief!.action.body).not.toMatch(/\{\{/);
    // Both modules of step 1 are offered together, the email and the LinkedIn connect.
    expect(brief!.modules.map((m) => m.action.type)).toEqual(['EMAIL', 'LINKEDIN_CONNECT']);
    // What Twenty itself says about the person, carried onto the panel.
    expect(brief!.podName).toBe('Pod Alisa');
    expect(brief!.ownerName).toBe('Alisa Marsh');
    expect(brief!.person.tier).toBe('LEVEL_1');
    expect(brief!.person.leadSource).toEqual(['FPA_WISCONSIN_JULY_2026']);
    // Tomas Berg is a colleague at Acme Logistics (not enrolled); Mateo Silva too
    expect(brief!.colleagues.map((c) => c.name)).toEqual(expect.arrayContaining(['Tomas Berg', 'Mateo Silva']));
    expect(brief!.nextStep?.step.day).toBe(3);
    expect(brief!.nextStep?.plannedDate).toBe('2026-09-09');
    expect(brief!.nextStep?.description).toBe('Call 1, then Follow-up email');
    expect(brief!.notes.map((n) => n.id)).toEqual(['note-01']); // from the mock workspace
    expect(brief!.twentyUrl).toContain('/object/person/person-01');

    // a junior from another pod may not see it
    const daniel = sessionUser(b.users.daniel, [b.pods.Leigh.id]);
    expect(await getTaskBrief(email1.id, daniel)).toBeNull();
  });
});
