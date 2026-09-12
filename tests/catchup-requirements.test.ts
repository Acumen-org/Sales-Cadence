import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { peopleScopeWhere } from '@/lib/people-scope';
import { listAccounts } from '@/lib/accounts-query';
import { isInternalCompany } from '@/lib/internal-organizations';
import { enrollPeople, previewEnrollment, exitEnrollment } from '@/lib/engine/enrollment';
import { completeTask, advanceEnrollment } from '@/lib/engine/tasks';
import { delegateTasks } from '@/lib/engine/delegate';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { canActOnTask } from '@/lib/auth/rbac';
import { filterEnrichmentQueue, getEnrichmentBatch, reviewEnrichmentRows, type EnrichmentQueueItem } from '@/lib/enrichment';
let b: Basics;
beforeEach(async () => { await resetDb(); b = await seedBasics(); });
const actor = (user: Basics['users']['ria']): SessionUser => ({ ...user, podIds: [], pods: [] });
describe('current requirements regression audit', () => {
  it('lets Biz Ops inspect another member\'s enrichment import without approving changes', async () => {
    const batch = await prisma.enrichmentBatch.create({ data: { name: 'Read-only oversight', entity: 'person', createdById: b.users.alisa.id } });
    const ops: SessionUser = { ...actor(b.users.karson), role: 'BIZ_OPS' };
    expect((await getEnrichmentBatch(ops, batch.id))?.id).toBe(batch.id);
    await expect(reviewEnrichmentRows(ops, batch.id, [], 'approve')).rejects.toThrow();
  });
  it('repeats a combined touchpoint after five business days only after both actions finish', async () => {
    const sequence = await prisma.sequence.create({ data: { name: 'Keep in touch', repeatEveryDays: 5, steps: [{ id: 'check-in', day: 1, actions: [{ id: 'email', type: 'EMAIL', label: 'Email', template: 'Hi {{firstName}}' }, { id: 'call', type: 'CALL', label: 'Call' }] }] } });
    const ctx = { actor: SYSTEM_ACTOR, now: new Date('2026-09-14T15:00:00Z'), skipSync: true };
    const result = await enrollPeople({ personIds: ['person-01'], sequenceId: sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, ctx);
    const id = result.enrolled[0].enrollmentId;
    const tasks = await prisma.task.findMany({ where: { enrollmentId: id }, orderBy: { actionIndex: 'asc' } });
    expect(tasks).toHaveLength(2);
    await completeTask({ taskId: tasks[0].id, source: 'MANUAL' }, ctx);
    expect(await prisma.enrollment.count({ where: { sequenceId: sequence.id } })).toBe(1);
    await completeTask({ taskId: tasks[1].id, source: 'MANUAL' }, ctx);
    const next = await prisma.enrollment.findFirstOrThrow({ where: { sequenceId: sequence.id, status: 'ACTIVE' } });
    expect(next).toMatchObject({ cycle: 2, startDate: '2026-09-21', foUserId: b.users.alisa.id, campaignId: null });
    await advanceEnrollment(id, ctx);
    expect(await prisma.enrollment.count({ where: { sequenceId: sequence.id } })).toBe(2);
    await exitEnrollment(next.id, { ...ctx, reason: 'Stop follow-up' });
    await advanceEnrollment(next.id, ctx);
    expect(await prisma.enrollment.count({ where: { sequenceId: sequence.id, status: 'ACTIVE' } })).toBe(0);
  });
  it('a pod manager delegates the current touchpoint while the enrollment keeps its FO', async () => {
    const ctx = { actor: SYSTEM_ACTOR, now: new Date('2026-09-14T15:00:00Z'), skipSync: true };
    const result = await enrollPeople({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, ctx);
    const id = result.enrolled[0].enrollmentId;
    const tasks = await prisma.task.findMany({ where: { enrollmentId: id, state: 'PENDING' } });
    const manager: SessionUser = { ...actor(b.users.alisa), role: 'POD_MANAGER', podIds: [b.pods.Alisa.id] };
    expect((await delegateTasks(tasks.map((t) => t.id), b.users.karson.id, manager)).ok).toBe(true);
    expect(await prisma.task.count({ where: { enrollmentId: id, foUserId: b.users.karson.id } })).toBe(tasks.length);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id } })).foUserId).toBe(b.users.alisa.id);
    expect((await delegateTasks(tasks.map((t) => t.id), b.users.daniel.id, manager)).ok).toBe(false);
  });
  it('excludes named internal organisations while retaining unknown and similarly named domains', async () => {
    await prisma.companyCache.createMany({ data: [
      { id: 'internal-name', name: 'Acumen-talent' },
      { id: 'internal-domain', name: 'Our staff', domain: 'https://www.glynac.ai/team' },
      { id: 'unknown-domain', name: 'Prospect with no website' },
      { id: 'similar-domain', name: 'Another prospect', domain: 'notglynac.ai' },
    ] });
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { companyId: 'internal-name', email: null } });
    await prisma.personCache.update({ where: { id: 'person-02' }, data: { email: b.users.karson.email } });
    const user = actor(b.users.ria);
    const accounts = await listAccounts(user);
    const ids = accounts.rows.map((r) => r.id);
    expect(ids).toContain('unknown-domain'); expect(ids).toContain('similar-domain');
    expect(ids).not.toContain('internal-name'); expect(ids).not.toContain('internal-domain');
    const people = await prisma.personCache.findMany({ where: await peopleScopeWhere(user), select: { id: true } });
    expect(people.map((p) => p.id)).not.toContain('person-01');
    expect(people.map((p) => p.id)).not.toContain('person-02');
    expect(await prisma.personCache.count({ where: { id: { in: ['person-01', 'person-02'] } } })).toBe(2);
    expect(isInternalCompany({ name: 'External', domain: 'glynac.ai.example.com' }, { internalDomains: ['glynac.ai'], internalCompanyNames: [] })).toBe(false);
  });
  it('reserves owned contacts before balancing unowned contacts and blocks an unavailable owner', async () => {
    const ids = ['balance-free-1', 'balance-free-2', 'balance-owned-1', 'balance-owned-2', 'balance-unavailable'];
    await prisma.personCache.createMany({ data: ids.map((id) => ({ id, firstName: id, lastName: 'Prospect', podOwner: 'ALISA', ownerMemberId: id.includes('owned') ? b.users.alisa.twentyMemberId : id.includes('unavailable') ? 'unknown-member' : null })) });
    const preview = await previewEnrollment({ personIds: ids, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR });
    expect(preview.candidates.filter((c) => c.foUserId === b.users.alisa.id)).toHaveLength(2);
    expect(preview.candidates.filter((c) => c.foUserId === b.users.karson.id)).toHaveLength(2);
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ personId: 'balance-unavailable', reason: 'no_fo' }));
  });
  it('never assigns outreach to Biz Ops or grants write access to a legacy assigned task', async () => {
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { role: 'BIZ_OPS' } });
    await expect(previewEnrollment({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', assignment: { mode: 'FIXED', foUserId: b.users.karson.id }, actor: SYSTEM_ACTOR })).rejects.toThrow('active member');
    expect(canActOnTask({ id: b.users.karson.id, role: 'BIZ_OPS', podIds: [b.pods.Alisa.id] }, { foUserId: b.users.karson.id, podId: b.pods.Alisa.id })).toBe(false);
  });
  it('uses the same multi-field and multi-word filters for the enrichment table and export', () => {
    const items: EnrichmentQueueItem[] = [
      { id: '1', label: 'Jane Smith', company: 'Example Fund', entity: 'person', href: '/people/1', gaps: [{ field: 'email', label: 'Email', priority: 'critical' }] },
      { id: '2', label: 'John Smith', company: 'Example Fund', entity: 'person', href: '/people/2', gaps: [{ field: 'phone', label: 'Phone', priority: 'critical' }] },
      { id: '3', label: 'Other', company: null, entity: 'person', href: '/people/3', gaps: [{ field: 'jobTitle', label: 'Title', priority: 'useful' }] },
    ];
    expect(filterEnrichmentQueue(items, ' Smith   Example ', ['email', 'phone']).map((i) => i.id)).toEqual(['1', '2']);
    expect(filterEnrichmentQueue(items, '', ['email']).map((i) => i.id)).toEqual(['1']);
  });
});
