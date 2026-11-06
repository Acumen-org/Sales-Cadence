import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { CampaignDraftSchema, type CampaignDraft } from '@/lib/campaign-planner';
import { campaignPeoplePage } from '@/lib/campaign-people-page';
import { activateCampaign } from '@/lib/engine/campaigns';
import { bellWords } from '@/lib/notifications';
import { describeAudit } from '@/lib/audit-format';
import { runTool } from '../scripts/local-runtime';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { coldDraft, publishColdCampaign, sessionOf } from './helpers/cold-campaign';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => '/campaigns', useSearchParams: () => new URLSearchParams(), redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('not found'); } }));
const { PlannedCampaignDetail } = await import('@/components/campaigns/planned-campaign-detail');

/**
 * Stage S11a (W14): the release's last clean-ups. Each migration is run a second time here on rows
 * made to look as they did before it, which shows what it does and that a second run changes nothing.
 */

/** Run one migration's SQL again, as `prisma migrate deploy` ran it. */
function rerun(name: string) {
  const file = path.join('prisma', 'migrations', name, 'migration.sql');
  const r = runTool(process.cwd(), 'prisma', ['db', 'execute', '--file', file, '--url', process.env.DATABASE_URL!], process.env, 'pipe');
  if (r.status !== 0) throw new Error(`${name} failed: ${r.stderr || r.stdout}`);
}

const LEGACY = '20261106300000_cold_campaigns_on_the_studio';

describe('cold outreach, the finish (S11a, W14)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('PLAN 9.7 step 14: cold campaigns from before the studio are put on it, so nothing reaches the old launcher or page', async () => {
    const alisa = b.users.alisa.id, karson = b.users.karson.id;
    const sally = await prisma.user.create({ data: { email: 'sally@cadence.local', name: 'Sally Leader', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    const gone = await prisma.user.create({ data: { email: 'gone@cadence.local', name: 'Gone Rep', role: 'JUNIOR_FO', passwordHash: 'x', active: false } });
    const [one, two, three] = await Promise.all([readyContact(alisa, b.pods.Alisa.id), readyContact(karson, b.pods.Alisa.id), readyContact(karson, b.pods.Alisa.id)]);
    // As the old Start campaign form left them: no studio plan, a library sequence, no end date.
    const old = (name: string, status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED', personIds: string[], createdById: string) =>
      prisma.campaign.create({ data: { name, audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds, startDate: '2026-11-04', status, createdById, approvedAt: status === 'DRAFT' ? null : new Date('2026-11-03T12:00:00Z'), approvedById: status === 'DRAFT' ? null : alisa, startsPerFoPerDay: 5 } });
    const scheduled = await old('Waiting to start', 'SCHEDULED', [one.id], alisa);
    const paused = await old('Paused before it started', 'PAUSED', [one.id], gone.id);
    const running = await old('Running since 4 Nov', 'ACTIVE', [two.id], alisa);
    const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: two.id, campaignId: running.id, foUserId: karson, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-04', currentStep: 0, audience: 'SANDBOX' } });
    const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: karson, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'EMAIL', label: 'Email 1', dueDate: '2026-11-04', dueAt: new Date('2026-11-04T09:00:00Z'), plannedDate: '2026-11-04' } });
    const done = await old('Finished', 'COMPLETED', [three.id], alisa);
    await prisma.enrollment.create({ data: { sandboxContactId: three.id, campaignId: done.id, foUserId: karson, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-04', status: 'COMPLETED', audience: 'SANDBOX' } });
    const draft = await old('Never sent', 'DRAFT', [three.id], alisa);
    const crm = await prisma.campaign.create({ data: { name: 'CRM from before', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: ['person-01'], startDate: '2026-11-04', status: 'SCHEDULED' } });
    const studio = (await publishColdCampaign(await sessionOf(alisa), coldDraft(b.pods.Alisa.id, [(await readyContact(alisa, b.pods.Alisa.id)).id], [alisa], { name: 'Built in the studio' }))).campaign;
    const studioBefore = await prisma.campaign.findUniqueOrThrow({ where: { id: studio.id } });

    rerun(LEGACY);

    const get = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
    // Not started: back to draft, nothing was sent, its creator told; a creator who left, the pod's leaders.
    expect(await get(scheduled.id)).toEqual(expect.objectContaining({ status: 'DRAFT', approvedAt: null, approvedById: null }));
    expect(await get(paused.id)).toEqual(expect.objectContaining({ status: 'DRAFT', approvedAt: null }));
    const told = await prisma.notification.findMany({ where: { kind: 'campaign_back_to_draft' }, orderBy: { userId: 'asc' } });
    expect(told.map((n) => [n.userId, (n.payload as { campaignId: string }).campaignId]).sort()).toEqual([[alisa, scheduled.id], [sally.id, paused.id]].sort());
    expect(bellWords(told[0], { people: new Map(), contacts: new Map(), users: new Map() }).title).toBe('Cold campaigns are now built in the campaign studio, so this one is a draft again');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: scheduled.id, action: 'back_to_draft' } });
    expect(audit.details).toEqual(expect.objectContaining({ from: 'SCHEDULED', to: 'DRAFT', approvedById: alisa }));
    expect(describeAudit('back_to_draft', {}, null, 'campaign').known).toBe(true);
    expect(describeAudit('studio_plan_added', {}, null, 'campaign').known).toBe(true);

    // Every one now has the plan the studio opens: its own fields, one Default group with the sequence's steps.
    const plan = (await get(scheduled.id)).plannerDraft as CampaignDraft;
    expect(plan).toEqual(expect.objectContaining({ name: 'Waiting to start', podId: b.pods.Alisa.id, startDate: '2026-11-04', endDate: '2026-12-16', personIds: [one.id], fos: [], defaultBatchSize: 5, outreachEdited: true }));
    expect(plan.flows).toEqual([expect.objectContaining({ id: 'default', name: 'Default', steps: b.sequence.steps })]);
    // It is a draft the studio can publish once someone picks a product and who runs it.
    expect(CampaignDraftSchema.safeParse({ ...plan, startDate: '2026-11-09', endDate: '2026-12-18', productInterest: ['PHH'], fos: [{ id: alisa, batchSize: 5 }] }).success).toBe(true);

    // A running one carries on exactly as it was, with the reps running it as its team.
    const live = await get(running.id);
    expect(live).toEqual(expect.objectContaining({ status: 'ACTIVE', endDate: null, publishedPlan: null }));
    expect((live.plannerDraft as CampaignDraft).fos).toEqual([{ id: karson, batchSize: 5 }]);
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).toEqual(expect.objectContaining({ status: 'ACTIVE', currentStep: 0, scheduleDates: [] }));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('PENDING');
    expect((await get(done.id)).plannerDraft).toBeTruthy();
    expect(await get(draft.id)).toEqual(expect.objectContaining({ status: 'DRAFT', plannerDraft: expect.objectContaining({ name: 'Never sent' }) }));
    // CRM campaigns and studio-built cold ones are not touched.
    expect((await get(crm.id)).plannerDraft).toBeNull();
    expect((await get(studio.id)).updatedAt).toEqual(studioBefore.updatedAt);
    expect(await prisma.auditLog.count({ where: { action: 'studio_plan_added' } })).toBe(5);

    // The one campaign page draws it: its contacts on their own pages, and no end date it never had.
    const people = await campaignPeoplePage(live, undefined, undefined);
    const html = renderToStaticMarkup(createElement(PlannedCampaignDetail, { campaign: live, manager: true, people }));
    expect(html).toContain('When the last contact finishes');
    expect(html).toContain(`/cold-outreach/${two.id}`);

    // A second run changes nothing.
    rerun(LEGACY);
    expect(await prisma.auditLog.count({ where: { action: { in: ['studio_plan_added', 'back_to_draft'] } } })).toBe(7);
    expect(await prisma.notification.count({ where: { kind: 'campaign_back_to_draft' } })).toBe(2);
  });

  it('B050 (W14, PLAN 8.12 M3): the CHECK that an owned contact has a pod is validated, after any row that would fail is put right and audited', async () => {
    const VALIDATE = '20261106300100_owned_contact_has_pod_validated';
    // Rows from before the CHECK, which NOT VALID let stay: an owner in a pod, and an admin owner.
    await prisma.$executeRawUnsafe('ALTER TABLE "SandboxContact" DROP CONSTRAINT "SandboxContact_owner_has_pod"');
    const podless = await readyContact(b.users.karson.id, b.pods.Alisa.id, { podId: null });
    const adminOwned = await readyContact(b.users.ria.id, b.pods.Alisa.id, { podId: null });
    const fine = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.$executeRawUnsafe('ALTER TABLE "SandboxContact" ADD CONSTRAINT "SandboxContact_owner_has_pod" CHECK ("ownerId" IS NULL OR "podId" IS NOT NULL) NOT VALID');
    const validated = async () => (await prisma.$queryRawUnsafe<{ v: boolean }[]>(`SELECT convalidated AS v FROM pg_constraint WHERE conname = 'SandboxContact_owner_has_pod'`))[0]?.v;
    expect(await validated()).toBe(false);

    rerun(VALIDATE);

    expect(await validated()).toBe(true);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: podless.id } })).toEqual(expect.objectContaining({ ownerId: b.users.karson.id, podId: b.pods.Alisa.id }));
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: adminOwned.id } })).toEqual(expect.objectContaining({ ownerId: null, podId: null, claimedAt: null }));
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: podless.id, action: 'pod_set_by_migration' } })).details).toEqual(expect.objectContaining({ migration: VALIDATE, podId: b.pods.Alisa.id }));
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: adminOwned.id, action: 'released_by_migration' } })).details).toEqual(expect.objectContaining({ migration: VALIDATE, from: b.users.ria.id }));
    expect(await prisma.auditLog.count({ where: { entityId: fine.id } })).toBe(0);
    await expect(prisma.sandboxContact.update({ where: { id: fine.id }, data: { podId: null } })).rejects.toThrow();

    rerun(VALIDATE);
    expect(await prisma.auditLog.count({ where: { action: { in: ['pod_set_by_migration', 'released_by_migration'] } } })).toBe(2);
  });

  it('PLAN 9.7 steps 0 and 7-13: the release clean-up runs once by itself, puts right what is safe and lists the rest', async () => {
    const { alisa, karson, daniel } = b.users;
    const Alisa = b.pods.Alisa.id, Leigh = b.pods.Leigh.id;
    const enroll = async (contactId: string, foUserId: string, podId: string, status: 'ACTIVE' | 'PAUSED' = 'ACTIVE') => {
      const e = await prisma.enrollment.create({ data: { sandboxContactId: contactId, foUserId, podId, sequenceId: b.sequence.id, startDate: '2026-11-04', currentStep: 0, status, audience: 'SANDBOX' } });
      const t = await prisma.task.create({ data: { enrollmentId: e.id, foUserId, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'EMAIL', label: 'Email 1', dueDate: '2026-11-04', dueAt: new Date('2026-11-04T09:00:00Z'), plannedDate: '2026-11-04' } });
      return { e, t };
    };
    // Step 8: Alisa's contact whose next step and campaign stayed with Karson; one whose campaign runs in another pod.
    const drifted = await readyContact(alisa.id, Alisa);
    const next = await prisma.nextAction.create({ data: { sandboxContactId: drifted.id, foUserId: karson.id, label: 'Call', action: 'CALL', dueDate: '2026-11-10', audience: 'SANDBOX' } });
    const run = await enroll(drifted.id, karson.id, Alisa);
    const elsewhere = await readyContact(alisa.id, Alisa);
    const far = await enroll(elsewhere.id, daniel.id, Leigh);
    // N001: opted out from the post-call form while its move ran; the CRM person was never opted out.
    const raced = await readyContact(alisa.id, Alisa, { status: 'MOVED', twentyPersonId: 'person-04', movedAt: new Date('2026-11-04T12:00:00Z'), optedOutAt: new Date('2026-11-04T11:59:00Z'), optOutSource: 'call_form' });
    // N002: opted out, its campaign still running.
    const out = await readyContact(alisa.id, Alisa, { status: 'OPTED_OUT', optedOutAt: new Date('2026-11-04T10:00:00Z') });
    const stale = await enroll(out.id, alisa.id, Alisa);
    // N025: two live contacts with one personal email.
    const first = await readyContact(alisa.id, Alisa, { email: 'jo.lee@lee-wealth.com', createdAt: new Date('2026-11-03T10:00:00Z') });
    const second = await readyContact(karson.id, Alisa, { email: 'Jo.Lee@lee-wealth.com' });
    // N058, N059: bounced by a delay notice; bounced for real.
    const delayed = await readyContact(alisa.id, Alisa, { badEmail: true });
    await prisma.sandboxEmail.create({ data: { sandboxContactId: delayed.id, kind: 'BOUNCE', internetMessageId: 'ndr-1', subject: 'Delivery Status Notification (Delay)', at: new Date('2026-11-04T09:00:00Z') } });
    const bounced = await readyContact(alisa.id, Alisa, { badEmail: true });
    await prisma.sandboxEmail.create({ data: { sandboxContactId: bounced.id, kind: 'SENT', internetMessageId: 'sent-2', conversationId: 'conv-2', subject: 'Hello', at: new Date('2026-11-04T08:00:00Z') } });
    await prisma.sandboxEmail.create({ data: { sandboxContactId: bounced.id, kind: 'BOUNCE', internetMessageId: 'ndr-2', conversationId: 'conv-2', subject: 'Undeliverable: Hello', at: new Date('2026-11-04T09:00:00Z') } });
    // N003, listed: the CRM marks this person Do not contact; the cold contact has the same name and firm.
    const crm = await prisma.personCache.update({ where: { id: 'person-02' }, data: { dnd: true } });
    const twin = await readyContact(alisa.id, Alisa, { firstName: crm.firstName, lastName: crm.lastName, companyName: crm.companyName });
    // N016, listed: emailed after the opt-out.
    await prisma.sandboxEmail.create({ data: { sandboxContactId: out.id, kind: 'SENT', internetMessageId: 'sent-3', subject: 'Checking in', at: new Date('2026-11-05T09:00:00Z') } });
    // Step 13, listed and never deleted.
    const test = await readyContact(alisa.id, Alisa, { firstName: 'WRD probe' });

    const { coldOutreachReleaseOnce, runColdOutreachRelease, releaseReport } = await import('@/lib/outreach/release');
    const r = (await coldOutreachReleaseOnce())!;

    // Step 0: the counts.
    expect(r.counts.contacts).toEqual({ ACTIVE: 8, MOVED: 1, OPTED_OUT: 1, unclaimed: 0, withoutPod: 0 });
    // Step 8: given to the owner, as a transfer gives it; the campaign in Leigh's pod keeps its rep.
    expect(r.drift).toEqual(expect.objectContaining({ contacts: 1, nextSteps: 1, enrollments: 1, tasks: 1, kept: { count: 1, ids: [elsewhere.id] } }));
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: next.id } })).foUserId).toBe(alisa.id);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: run.e.id } })).foUserId).toBe(alisa.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: run.t.id } })).foUserId).toBe(alisa.id);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: far.e.id } })).foUserId).toBe(daniel.id);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: drifted.id, action: 'work_given_to_owner' } })).details).toEqual(expect.objectContaining({ to: alisa.id, nextSteps: 1, enrollments: 1 }));
    // N001: the CRM person is opted out too, from the contact's own source, so a form opt-out stays liftable.
    expect(r.movedWhileOptedOut.ids).toEqual(['person-04']);
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-04' } })).toEqual(expect.objectContaining({ optedOut: true, optOutSource: 'call_form' }));
    expect(raced.status).toBe('MOVED');
    // N002: the campaign ends as Opted out, its step cancelled.
    expect(r.endedForInactive.ids).toEqual([stale.e.id]);
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: stale.e.id } })).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'opted_out' }));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: stale.t.id } })).state).toBe('CANCELLED');
    // N025: the later one shows "Possibly the same as" the first.
    expect(r.duplicates.ids).toEqual([second.id]);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: second.id } })).possibleDuplicateId).toBe(first.id);
    // N058, N059: a delay notice is no bounce: a possible one, to clear or confirm. A real bounce stays.
    expect(r.doubtedBounces.ids).toEqual([delayed.id]);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: delayed.id } })).toEqual(expect.objectContaining({ badEmail: false, possibleBounceAt: new Date('2026-11-04T09:00:00Z') }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: bounced.id } })).badEmail).toBe(true);
    // Listed only.
    expect(r.dncByNameAndFirm.ids).toEqual([twin.id]);
    expect(r.emailsAfterOptOut.ids).toEqual([out.id]);
    expect(r.testData.ids).toEqual([test.id]);
    expect(await prisma.sandboxContact.count({ where: { id: test.id } })).toBe(1);
    expect(await releaseReport()).toEqual(expect.objectContaining({ at: r.at }));
    expect(describeAudit('release_checks', {}, null, 'settings').known).toBe(true);
    expect(describeAudit('work_given_to_owner', {}, null, 'sandbox_contact').known).toBe(true);
    expect(describeAudit('possible_duplicate_marked', {}, null, 'sandbox_contact').known).toBe(true);
    // Admins read it in Settings > Cold outreach; nobody else does.
    const { loadColdOutreachSettings } = await import('@/lib/sandbox/cold-settings');
    const { ColdOutreachSettings } = await import('@/components/settings/cold-outreach-settings');
    const settings = (canEdit: boolean) => loadColdOutreachSettings({ full: canEdit }).then((data) => renderToStaticMarkup(createElement(ColdOutreachSettings, { data, canEdit, timezone: 'Europe/London' })));
    const admin = await settings(true);
    expect(admin).toContain('Release clean-up');
    expect(admin).toContain('Given back to the owner');
    expect(await settings(false)).not.toContain('Release clean-up');

    // Once: the worker never runs it again, and a run by hand finds nothing left to put right.
    expect(await coldOutreachReleaseOnce()).toBeNull();
    const again = await runColdOutreachRelease();
    expect([again.drift.contacts, again.movedWhileOptedOut.count, again.endedForInactive.count, again.duplicates.count, again.doubtedBounces.count]).toEqual([0, 0, 0, 0, 0]);
  });

  it('W14: the old /tasks?audience=cold goes to Cold outreach > Tasks with its other filters; /tasks is the one list', async () => {
    const { default: TasksPage } = await import('@/app/(app)/tasks/page');
    await expect(TasksPage({ searchParams: Promise.resolve({ audience: 'cold', tab: 'overdue', type: 'CALL' }) })).rejects.toThrow('redirect:/cold-outreach/tasks?tab=overdue&type=CALL');
    await expect(TasksPage({ searchParams: Promise.resolve({ audience: 'cold' }) })).rejects.toThrow('redirect:/cold-outreach/tasks');
  });

  it('W14: a cold campaign is launched only from its published calendar; the old launcher is gone', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    // A cold campaign without a studio plan (none can be made since the release) does not start.
    const bare = await prisma.campaign.create({ data: { name: 'No plan', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [c.id], startDate: '2026-11-04', status: 'SCHEDULED' } });
    await expect(activateCampaign(bare.id, { actor: SYSTEM_ACTOR, now: new Date('2026-11-04T16:00:00Z'), skipSync: true })).rejects.toThrow('Not started: this campaign has no finished calendar');
    expect(await prisma.enrollment.count({ where: { campaignId: bare.id } })).toBe(0);
    expect('activateSandboxCampaign' in (await import('@/lib/sandbox/campaigns'))).toBe(false);
  });
});
