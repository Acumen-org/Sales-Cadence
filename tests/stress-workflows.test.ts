import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { enrollPeople } from '@/lib/engine/enrollment';
import { advanceEnrollment, completeTask } from '@/lib/engine/tasks';
import { ingestEvent } from '@/lib/engine/ingest';
import { rawFromNote, rawFromPerson } from '@/lib/engine/reconcile';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { upsertPersonCache, upsertCompanyCache } from '@/lib/person-cache';
import { listAccounts } from '@/lib/accounts-query';
import { peopleScopeWhere } from '@/lib/people-scope';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';

let b: Basics;
const now = new Date('2026-09-14T18:00:00Z');
const ctx = { now, actor: SYSTEM_ACTOR, skipSync: true };
beforeEach(async () => { await resetDb(); b = await seedBasics(); });
describe('stress: concurrent work and directory scale', () => {
  it('older CRM snapshots cannot overwrite newer contact or account data or resurrect deleted contacts', async () => {
    const mock = getMockTwentyClient();
    const person = await mock.getPerson('person-01');
    const company = mock.companies[0];
    expect(person).not.toBeNull();
    await upsertPersonCache({ ...person!, firstName: 'Current', updatedAt: '2026-09-14T18:00:00Z' });
    await upsertPersonCache({ ...person!, firstName: 'Stale', updatedAt: '2026-09-14T17:00:00Z' });
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: person!.id } })).firstName).toBe('Current');
    await upsertCompanyCache({ ...company, name: 'Current company', updatedAt: '2026-09-14T18:00:00Z' });
    await upsertCompanyCache({ ...company, name: 'Stale company', updatedAt: '2026-09-14T17:00:00Z' });
    expect((await prisma.companyCache.findUniqueOrThrow({ where: { id: company.id } })).name).toBe('Current company');
    await upsertPersonCache({ ...person!, deletedAt: '2026-09-14T19:00:00Z', updatedAt: '2026-09-14T18:00:00Z' });
    await upsertPersonCache({ ...person!, deletedAt: null, updatedAt: '2026-09-14T18:00:00Z' });
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: person!.id } })).deletedAt).not.toBeNull();
    await upsertPersonCache({ ...person!, firstName: 'Restored', deletedAt: null, updatedAt: '2026-09-14T20:00:00Z' });
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: person!.id } })).deletedAt).toBeNull();
  });
  it('a deletion with an unchanged CRM updatedAt is distinct from the prior update', async () => {
    const person = (await getMockTwentyClient().getPerson('person-01'))!;
    const record = rawFromPerson({ ...person, updatedAt: now.toISOString() });
    await ingestEvent({ source: 'WEBHOOK', objectType: 'person', eventName: 'person.updated', record, now, skipSync: true });
    const deleted = await ingestEvent({ source: 'WEBHOOK', objectType: 'person', eventName: 'person.deleted', record: { ...record, deletedAt: '2026-09-14T19:00:00Z' }, now, skipSync: true });
    expect(deleted.status).toBe('processed');
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: person.id } })).deletedAt?.toISOString()).toBe('2026-09-14T19:00:00.000Z');
  });
  it('a delayed do-not-contact update cannot exit work after a newer consent update', async () => {
    const person = (await getMockTwentyClient().getPerson('person-01'))!;
    await enrollPeople({ personIds: [person.id], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, ctx);
    await upsertPersonCache({ ...person, dnd: false, updatedAt: now.toISOString() });
    await ingestEvent({ source: 'WEBHOOK', objectType: 'person', eventName: 'person.updated', record: rawFromPerson({ ...person, dnd: true, updatedAt: '2026-09-14T17:00:00Z' }), now, skipSync: true });
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: person.id } })).status).toBe('ACTIVE');
  });
  it('16 concurrent enrollments and 32 webhook retries create one enrollment and resolve one action', async () => {
    const request = { personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', assignment: { mode: 'FIXED' as const, foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR };
    const runs = await Promise.all(Array.from({ length: 16 }, () => enrollPeople(request, ctx)));
    expect(runs.flatMap((r) => r.enrolled)).toHaveLength(1);
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01' } });
    const mock = getMockTwentyClient();
    const note = mock.addNote({ id: 'stress-outbound', title: '[Email] Outbound email: Follow-up', personIds: ['person-01'], createdByMemberId: 'wm-alisa', createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const input = { source: 'WEBHOOK' as const, objectType: 'note', eventName: 'note.created', record: rawFromNote(note), now, skipSync: true };
    const events = await Promise.all(Array.from({ length: 32 }, () => ingestEvent(input, mock)));
    expect(events.filter((event) => event.status === 'error')).toEqual([]);
    expect(events.filter((event) => event.status === 'processed')).toHaveLength(1);
    expect(await prisma.task.count({ where: { enrollmentId: enrollment.id, state: 'DONE' } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { externalId: note.id } })).toBe(1);
  });

  it('concurrent completion of both modules and scheduler ticks never duplicate the next step', async () => {
    const sequence = await prisma.sequence.create({ data: { name: 'Stress combined actions', steps: [
      { id: 'first', day: 1, actions: [{ id: 'email', type: 'EMAIL', label: 'Email' }, { id: 'call', type: 'CALL', label: 'Call' }] },
      { id: 'next', day: 2, actions: [{ id: 'follow-up', type: 'EMAIL', label: 'Follow-up' }] },
    ] } });
    const result = await enrollPeople({ personIds: ['person-01'], sequenceId: sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, ctx);
    const id = result.enrolled[0].enrollmentId;
    const tasks = await prisma.task.findMany({ where: { enrollmentId: id } });
    const completed = await Promise.all(Array.from({ length: 16 }, (_, i) => completeTask({ taskId: tasks[i % 2].id, source: 'MANUAL' }, ctx)));
    expect(completed.filter((r) => r.ok)).toHaveLength(2);
    await Promise.all(Array.from({ length: 16 }, () => advanceEnrollment(id, { ...ctx, now: new Date('2026-09-15T18:00:00Z') })));
    expect(await prisma.task.count({ where: { enrollmentId: id, stepId: 'next' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'task', entityId: { in: tasks.map((t) => t.id) }, action: 'completed' } })).toBe(2);
  });

  it('serves a 20,000-person / 6,000-account directory to 12 simultaneous readers without truncating totals', async () => {
    await prisma.companyCache.createMany({ data: Array.from({ length: 6000 }, (_, i) => ({ id: `stress-company-${i}`, name: `Stress company ${i}`, sortName: `stress company ${String(i).padStart(5, '0')}` })) });
    for (let offset = 0; offset < 20000; offset += 2000) {
      await prisma.personCache.createMany({ data: Array.from({ length: 2000 }, (_, i) => ({ id: `stress-person-${offset + i}`, firstName: 'Stress', lastName: `Person ${offset + i}`, companyId: `stress-company-${(offset + i) % 6000}`, podOwner: 'ALISA' })) });
    }
    const user: SessionUser = { ...b.users.ria, pods: [], podIds: [], timezone: 'America/Chicago' };
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => listAccounts(user, { q: 'Stress company', sort: 'name', page: i + 1 })));
    for (const result of results) { expect(result.total).toBe(6000); expect(result.rows).toHaveLength(100); }
    expect(new Set(results.flatMap((r) => r.rows.map((row) => row.id))).size).toBe(1200);
    expect(await prisma.personCache.count({ where: { AND: [await peopleScopeWhere(user), { id: { startsWith: 'stress-person-' } }] } })).toBe(20000);
    process.stdout.write(`[stress] 12 concurrent account pages: ${Math.round(performance.now() - start)}ms; 20,000 people / 6,000 accounts\n`);
  }, 60000);
});
