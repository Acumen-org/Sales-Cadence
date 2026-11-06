import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { SYSTEM_ACTOR, userActor } from '@/lib/audit';
import { addDays } from '@/lib/dates';
import { CampaignDraftSchema } from '@/lib/campaign-planner';
import { previewCampaignCalendar, saveCampaignCalendar } from '@/lib/campaign-planning-service';
import { campaignChoices } from '@/lib/campaign-membership';
import { addPeopleToCalendarCampaign } from '@/lib/campaign-people';
import { campaignPeoplePage } from '@/lib/campaign-people-page';
import { activateCampaign } from '@/lib/engine/campaigns';
import { advanceEnrollment } from '@/lib/engine/tasks';
import { logManualCall } from '@/lib/calls/form';
import { bellWords } from '@/lib/notifications';
import { optOutContact } from '@/lib/outreach/transitions';
import { activateSandboxCampaign, coldAudienceIssues, leftAtLaunch } from '@/lib/sandbox/campaigns';
import { listContacts } from '@/lib/sandbox/query';
import { COLD_CAMPAIGNS_HREF, COLD_CONTACT_BASE } from '@/lib/subject';
import { runTool } from '../scripts/local-runtime';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { coldDraft, firstWorkingDay, noonOf, publishColdCampaign, sessionOf } from './helpers/cold-campaign';

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => '/sandbox', useSearchParams: () => new URLSearchParams(), redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('not found'); } }));

const { addPeopleToCampaignAction, approveCampaignAction, rejectCampaignAction } = await import('@/lib/actions/campaigns');
const { reassignEnrollmentAction } = await import('@/lib/actions/enrollments');
const sandboxActions = await import('@/lib/actions/sandbox');
const { PlannedCampaignDetail } = await import('@/components/campaigns/planned-campaign-detail');
const { ColdCampaignNotes } = await import('@/components/campaigns/cold-campaign-notes');
const { CampaignsScreen } = await import('@/components/campaigns/campaigns-screen');
const { default: RetiredSequencePage } = await import('@/app/(app)/sequences/[id]/page');

/**
 * Stage S7 (cold outreach W7): cold campaigns on the campaign studio and the calendar engine, with no
 * approval. One test per bug id; N052 is out of scope (owner's D5 (c)).
 */
describe('cold campaigns on the campaign studio (S7)', () => {
  let b: Basics;
  let alisa: SessionUser, karson: SessionUser;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    alisa = await sessionOf(b.users.alisa.id);
    karson = await sessionOf(b.users.karson.id);
    auth.requireUser.mockResolvedValue(alisa);
  });
  const leader = () => prisma.user.create({ data: { email: 'sally@cadence.local', name: 'Sally Leader', role: 'SALES_LEADER', passwordHash: 'x', timezone: 'Europe/London', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
  const fd = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
  const launch = (id: string, day: string) => activateCampaign(id, { actor: SYSTEM_ACTOR, now: noonOf(day), skipSync: true });
  const draw = (el: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(el as never, props as never));

  it('B046: publishing a cold campaign schedules it with no approval, and its pod\'s leaders are told', async () => {
    const sally = await leader();
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    // Alisa is a Senior FO: before, her campaign waited for a leader. Now publishing schedules it.
    const { campaign } = await publishColdCampaign(alisa, coldDraft(b.pods.Alisa.id, [c.id], [b.users.alisa.id]));
    expect(campaign).toEqual(expect.objectContaining({ audience: 'SANDBOX', status: 'SCHEDULED', approvedById: b.users.alisa.id }));
    const told = await prisma.notification.findMany({ where: { kind: 'campaign_published' } });
    expect(told.map((n) => n.userId)).toEqual([sally.id]);
    const words = bellWords(told[0], { people: new Map(), contacts: new Map(), users: new Map([[alisa.id, alisa.name]]) });
    expect(words).toEqual(expect.objectContaining({ name: 'Cold Q4 Harbor', title: expect.stringContaining(`${alisa.name} published a cold campaign`), href: `/campaigns/${campaign.id}` }));
    expect(words.detail).toContain('You can pause or stop it on its page.');
    // No approval step anywhere: the old actions refuse a cold campaign, and say why.
    auth.requireUser.mockResolvedValue(await sessionOf(b.users.ria.id));
    expect(await approveCampaignAction(fd({ campaignId: campaign.id }))).toEqual({ ok: false, error: 'Cold campaigns need no approval: publishing one schedules it.' });
    expect(await rejectCampaignAction(fd({ campaignId: campaign.id }))).toEqual({ ok: false, error: expect.stringContaining('stop it or delete it') });
    // The old Start campaign form and its approval are gone.
    expect('startSandboxCampaignAction' in sandboxActions).toBe(false);
    expect('addToSandboxCampaignAction' in sandboxActions).toBe(false);
  });

  it('the release migration: a cold campaign waiting for approval becomes a draft, its creator is told, and none can wait again', async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_cold_needs_no_approval"');
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const waiting = await prisma.campaign.create({ data: { name: 'Waiting since 3 Nov', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [c.id], startDate: '2026-11-03', status: 'PENDING_APPROVAL', createdById: b.users.karson.id } });
    await prisma.user.update({ where: { id: b.users.andrew.id }, data: { active: false } });
    const orphan = await prisma.campaign.create({ data: { name: 'Left by Andrew', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [], startDate: '2026-11-03', status: 'PENDING_APPROVAL', createdById: b.users.andrew.id } });
    const followup = await prisma.campaign.create({ data: { name: 'CRM follow-up', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: ['person-01'], startDate: '2026-11-03', status: 'PENDING_APPROVAL' } });
    const sally = await leader();
    const file = path.join('prisma', 'migrations', '20261105600000_cold_campaigns_no_approval', 'migration.sql');
    const rerun = () => { const r = runTool(process.cwd(), 'prisma', ['db', 'execute', '--file', file, '--url', process.env.DATABASE_URL!], process.env, 'pipe'); if (r.status !== 0) throw new Error(String(r.stderr || r.stdout)); };
    rerun();
    rerun();
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: waiting.id } })).toEqual(expect.objectContaining({ status: 'DRAFT', approvedAt: null, approvedById: null, personIds: [c.id] }));
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: orphan.id } })).status).toBe('DRAFT');
    // A CRM follow-up still waits for its leader: that is the CRM's own rule.
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: followup.id } })).status).toBe('PENDING_APPROVAL');
    expect(await prisma.auditLog.count({ where: { action: 'approval_removed' } })).toBe(2);
    const told = await prisma.notification.findMany({ where: { kind: 'campaign_back_to_draft' }, orderBy: { userId: 'asc' } });
    expect(told.map((n) => [n.userId, (n.payload as { campaignId: string }).campaignId]).sort()).toEqual([[b.users.karson.id, waiting.id], [sally.id, orphan.id]].sort());
    expect(bellWords(told[0], { people: new Map(), contacts: new Map(), users: new Map() }).detail).toBe('Nothing was sent. Open it, check who is in it and publish it to schedule it.');
    await expect(prisma.campaign.update({ where: { id: waiting.id }, data: { status: 'PENDING_APPROVAL' } })).rejects.toThrow(/Campaign_cold_needs_no_approval/);
  });

  it('B045: a campaign\'s kind is set when it is made, and the studio refuses to change it', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const draft = coldDraft(b.pods.Alisa.id, [c.id], [b.users.alisa.id]);
    const saved = await saveCampaignCalendar(draft, alisa, { audience: 'SANDBOX' });
    expect(saved).toEqual(expect.objectContaining({ audience: 'SANDBOX', status: 'DRAFT' }));
    await expect(saveCampaignCalendar(draft, alisa, { id: saved.id, revision: saved.updatedAt.toISOString(), audience: 'CRM' })).rejects.toThrow('This is a cold campaign, so its people stay cold contacts.');
    const crm = await saveCampaignCalendar({ ...draft, personIds: ['person-01'] }, alisa, { audience: 'CRM' });
    await expect(saveCampaignCalendar(draft, alisa, { id: crm.id, revision: crm.updatedAt.toISOString(), audience: 'SANDBOX' })).rejects.toThrow('This is a CRM campaign, so its people stay CRM people.');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: saved.id } })).audience).toBe('SANDBOX');
  });

  it('B044: CRM people go into CRM campaigns and cold contacts into cold ones, offered and refused by kind', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const cold = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id]), alisa, { audience: 'SANDBOX' });
    const crm = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id], { name: 'CRM spring' }), alisa, { audience: 'CRM' });
    expect((await campaignChoices(alisa, { manageOnly: true })).map((x) => x.id)).toEqual([crm.id]);
    expect((await campaignChoices(alisa, { manageOnly: true, audience: 'SANDBOX' })).map((x) => x.id)).toEqual([cold.id]);
    expect(await addPeopleToCampaignAction(fd({ campaignId: cold.id, personIds: JSON.stringify(['person-01']) }))).toEqual({ ok: false, error: 'Cold Q4 Harbor is a cold campaign, so it takes cold contacts only. Add CRM people to a CRM campaign.' });
    expect(await addPeopleToCampaignAction(fd({ campaignId: crm.id, audience: 'SANDBOX', personIds: JSON.stringify([c.id]) }))).toEqual({ ok: false, error: 'CRM spring is a CRM campaign, so it takes CRM people only. Add cold contacts to a cold campaign.' });
    expect(await addPeopleToCampaignAction(fd({ campaignId: cold.id, audience: 'SANDBOX', personIds: JSON.stringify([c.id]) }))).toEqual(expect.objectContaining({ ok: true }));
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: cold.id } })).personIds).toEqual([c.id]);
  });

  it('B047: who publishing left out, and why, is kept and shown on the campaign page after the redirect', async () => {
    const ok = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const gone = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Gina', lastName: 'Gone' });
    await optOutContact(gone.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
    const { campaign, review } = await publishColdCampaign(alisa, coldDraft(b.pods.Alisa.id, [ok.id, gone.id], [b.users.alisa.id]));
    expect(review.leftOut).toEqual([expect.objectContaining({ id: gone.id, reason: 'Opted out' })]);
    expect(review.cold?.claims).toEqual([]);
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { pod: { select: { name: true } } } });
    expect((stored.publishedPlan as { cold: { leftOut: unknown[] } }).cold.leftOut).toEqual([{ id: gone.id, name: 'Gina Gone', reason: 'Opted out' }]);
    const html = renderToStaticMarkup((await ColdCampaignNotes({ campaign: stored, launched: false, timezone: 'Europe/London' }))!);
    expect(html).toContain('Left out when it was published (1)');
    expect(html).toContain('Gina Gone (opted out)');
  });

  it('B129 and N002: launch locks and re-checks every contact; nobody opted out meanwhile is started, and a launch with nobody left does not go active', async () => {
    const stays = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const leaves = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Olga', lastName: 'Out' });
    const draft = coldDraft(b.pods.Alisa.id, [stays.id, leaves.id], [b.users.alisa.id]);
    const { campaign } = await publishColdCampaign(alisa, draft);
    // The opt-out and the launch race, as an approval and an opt-out raced before (N002).
    await Promise.all([optOutContact(leaves.id, { source: 'contact_page', actor: userActor(b.users.alisa) }), launch(campaign.id, draft.startDate)]);
    expect(await prisma.enrollment.count({ where: { sandboxContactId: leaves.id, status: { in: ['ACTIVE', 'PAUSED'] } } })).toBe(0);
    expect(await prisma.task.count({ where: { state: 'PENDING', enrollment: { sandboxContactId: leaves.id } } })).toBe(0);
    expect(await prisma.enrollment.findFirstOrThrow({ where: { sandboxContactId: stays.id } })).toEqual(expect.objectContaining({ status: 'ACTIVE', audience: 'SANDBOX' }));

    // Everyone opted out after publishing: the campaign does not go active, and says why.
    const only = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Nina', lastName: 'Nobody' });
    const second = coldDraft(b.pods.Alisa.id, [only.id], [b.users.alisa.id], { name: 'Nobody left' });
    const { campaign: empty } = await publishColdCampaign(alisa, second);
    await optOutContact(only.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
    await prisma.campaign.update({ where: { id: empty.id }, data: { personIds: [only.id] } });
    await expect(launch(empty.id, second.startDate)).rejects.toThrow('Not started: nobody in it can be contacted now: Nina Nobody (opted out). Nobody has been contacted.');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: empty.id } })).status).toBe('SCHEDULED');
  });

  it('N002: the engine ends an enrollment whose contact can no longer be contacted, instead of making its next step', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const draft = coldDraft(b.pods.Alisa.id, [c.id], [b.users.alisa.id]);
    const { campaign } = await publishColdCampaign(alisa, draft);
    await launch(campaign.id, draft.startDate);
    const e = await prisma.enrollment.findFirstOrThrow({ where: { campaignId: campaign.id } });
    const before = await prisma.task.count({ where: { enrollmentId: e.id } });
    // Opted out behind the engine's back (a write that skipped the state machine): the safety net still holds.
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { status: 'OPTED_OUT', optedOutAt: new Date() } });
    expect((await advanceEnrollment(e.id, { actor: SYSTEM_ACTOR, now: noonOf(e.scheduleDates[1]), skipSync: true })).outcome).toBe('inactive');
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: e.id } })).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'opted_out' }));
    expect(await prisma.task.count({ where: { enrollmentId: e.id } })).toBe(before);
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'PENDING' } })).toBe(0);
  });

  it('N019: a launch after the start date never backdates the plan: everything starts from the launch day, and the dates are saved', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const draft = coldDraft(b.pods.Alisa.id, [c.id], [b.users.alisa.id]);
    const { campaign } = await publishColdCampaign(alisa, draft);
    const late = addDays(draft.startDate, 7);
    await launch(campaign.id, late);
    const e = await prisma.enrollment.findFirstOrThrow({ where: { campaignId: campaign.id }, include: { tasks: true } });
    expect(e.scheduleDates[0]).toBe(late);
    expect(e.tasks.every((t) => t.dueDate >= late)).toBe(true);
    const saved = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(saved.startDate).toBe(late);
    expect(saved.endDate! >= e.scheduleDates.at(-1)!).toBe(true);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: campaign.id, action: 'started' } })).details).toEqual(expect.objectContaining({ startMoved: expect.objectContaining({ from: draft.startDate, to: late }) }));

    // A cold campaign from before the studio, waiting since 3 Nov, starts today when it launches, not on 3 Nov.
    const old = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const legacy = await prisma.campaign.create({ data: { name: 'From the old form', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [old.id], startDate: '2026-11-03', status: 'SCHEDULED' } });
    await activateSandboxCampaign(legacy.id, { actor: SYSTEM_ACTOR, now: noonOf(late), skipSync: true });
    expect((await prisma.enrollment.findFirstOrThrow({ where: { campaignId: legacy.id } })).startDate).toBe(late);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: legacy.id } })).startDate).toBe(late);
  });

  it('N021: contacts who said Not interested or booked a meeting after it was planned are left out at launch, by name', async () => {
    const fine = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const no = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Nate', lastName: 'No' });
    const met = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Mia', lastName: 'Met' });
    const draft = coldDraft(b.pods.Alisa.id, [fine.id, no.id, met.id], [b.users.alisa.id]);
    const { campaign } = await publishColdCampaign(alisa, draft);
    await prisma.sandboxContact.update({ where: { id: no.id }, data: { lastOutcome: 'not_interested', lastOutcomeAt: new Date(Date.now() + 1000) } });
    await prisma.nextAction.create({ data: { sandboxContactId: met.id, foUserId: b.users.alisa.id, label: 'Meeting', action: 'CALL', kind: 'MEETING', dueDate: addDays(draft.startDate, 3), audience: 'SANDBOX' } });
    const r = await launch(campaign.id, draft.startDate);
    expect(r).toEqual({ enrolled: 1, skipped: 2 });
    const left = await leftAtLaunch(campaign.id);
    expect(left?.people).toEqual(expect.arrayContaining([expect.objectContaining({ id: no.id, reason: expect.stringMatching(/^Said Not interested on /) }), expect.objectContaining({ id: met.id, reason: 'Has a meeting booked' })]));
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { pod: { select: { name: true } } } });
    expect(renderToStaticMarkup((await ColdCampaignNotes({ campaign: stored, launched: true, timezone: 'Europe/London' }))!)).toContain('Mia Met (has a meeting booked)');
  });

  it('B135: the studio says who runs the campaign; an unclaimed contact is claimed at launch by its FO, through the one transfer', async () => {
    const free = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null, claimedAt: null, podId: null });
    const draft = coldDraft(b.pods.Alisa.id, [free.id], [b.users.karson.id]);
    const { campaign, review } = await publishColdCampaign(alisa, draft);
    expect(review.cold?.claims).toEqual([{ foId: b.users.karson.id, name: b.users.karson.name, count: 1 }]);
    await launch(campaign.id, draft.startDate);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: free.id } })).toEqual(expect.objectContaining({ ownerId: b.users.karson.id, podId: b.pods.Alisa.id }));
    expect(await prisma.enrollment.findFirstOrThrow({ where: { sandboxContactId: free.id } })).toEqual(expect.objectContaining({ foUserId: b.users.karson.id }));
    expect(await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'sandbox_contact', entityId: free.id, action: 'claimed' } })).toEqual(expect.objectContaining({ details: expect.objectContaining({ to: b.users.karson.id, reason: 'campaign_launch' }) }));
    // A contact someone owns stays theirs: it is left out until its owner runs the campaign too, with Add <owner> offered.
    const hers = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const plan = await previewCampaignCalendar(coldDraft(b.pods.Alisa.id, [hers.id], [b.users.karson.id], { name: 'Karson only' }), alisa, undefined, 'SANDBOX');
    expect(plan.leftOut).toEqual([expect.objectContaining({ id: hers.id, reason: `Owned by ${b.users.alisa.name}, who is not on this campaign`, ownerId: b.users.alisa.id })]);
  });

  it('B132: a Junior FO plans and adds only his own and unclaimed contacts, in the studio and in Add to campaign', async () => {
    const mine = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    const hers = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const plan = await previewCampaignCalendar(coldDraft(b.pods.Alisa.id, [mine.id, hers.id], [b.users.karson.id, b.users.alisa.id]), karson, undefined, 'SANDBOX');
    expect(plan.leftOut).toEqual([expect.objectContaining({ id: hers.id, reason: `Owned by ${b.users.alisa.name}. Junior FOs add only their own contacts` })]);
    const draft = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.karson.id]), karson, { audience: 'SANDBOX' });
    expect(await addPeopleToCalendarCampaign(karson, draft, [hers.id])).toEqual({ ok: false, error: expect.stringContaining('Junior FOs add only their own contacts') });
    expect(await addPeopleToCalendarCampaign(karson, draft, [mine.id])).toEqual(expect.objectContaining({ ok: true }));
  });

  it('B130: adding nobody is an error that says why, never a green "Added 0"', async () => {
    const gone = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Gus', lastName: 'Gone' });
    await optOutContact(gone.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
    const inIt = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const draft = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [inIt.id], [b.users.alisa.id]), alisa, { audience: 'SANDBOX' });
    expect(await addPeopleToCampaignAction(fd({ campaignId: draft.id, audience: 'SANDBOX', personIds: JSON.stringify([gone.id]) }))).toEqual({ ok: false, error: 'Nobody could be added to Cold Q4 Harbor: Gus Gone (opted out).' });
    expect(await addPeopleToCampaignAction(fd({ campaignId: draft.id, audience: 'SANDBOX', personIds: JSON.stringify([inIt.id]) }))).toEqual({ ok: false, error: 'Everyone chosen is already in Cold Q4 Harbor.' });
  });

  it('B131: Add to campaign offers only cold studio campaigns this reader may change, never one from before the studio or one whose start passed unstarted', async () => {
    const hers = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id], { name: 'Alisa only' }), alisa, { audience: 'SANDBOX' });
    const both = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id, b.users.karson.id], { name: 'Both of us' }), alisa, { audience: 'SANDBOX' });
    await prisma.campaign.create({ data: { name: 'Old form', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [], startDate: firstWorkingDay(), status: 'SCHEDULED' } });
    const stale = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.karson.id], { name: 'Never started' }), alisa, { audience: 'SANDBOX' });
    await prisma.campaign.update({ where: { id: stale.id }, data: { status: 'SCHEDULED', startDate: '2026-11-02' } });
    expect((await campaignChoices(karson, { manageOnly: true, audience: 'SANDBOX' })).map((c) => c.name)).toEqual(['Both of us']);
    expect((await campaignChoices(alisa, { manageOnly: true, audience: 'SANDBOX' })).map((c) => c.id).sort()).toEqual([hers.id, both.id].sort());
  });

  it('B133: a cold campaign is made in the campaign studio, on the calendar engine', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const draft = coldDraft(b.pods.Alisa.id, [c.id], [b.users.alisa.id]);
    const { campaign } = await publishColdCampaign(alisa, draft);
    expect(campaign.plannerDraft).toBeTruthy();
    expect((campaign.publishedPlan as { valid: boolean }).valid).toBe(true);
    await launch(campaign.id, draft.startDate);
    expect((await prisma.enrollment.findFirstOrThrow({ where: { campaignId: campaign.id } })).scheduleDates.length).toBe(2);
  });

  it('B134 and B102: the cold campaign page is the campaign page, with stats, per-contact actions and labels, and no link to People', async () => {
    const stays = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const moved = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Mo', lastName: 'Moved' });
    const draft = coldDraft(b.pods.Alisa.id, [stays.id, moved.id], [b.users.alisa.id]);
    const { campaign } = await publishColdCampaign(alisa, draft);
    await launch(campaign.id, draft.startDate);
    await prisma.enrollment.updateMany({ where: { sandboxContactId: moved.id }, data: { status: 'EXITED', exitReason: 'moved_to_crm' } });
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    const people = await campaignPeoplePage(c, undefined, undefined);
    expect(people.rows.every((r) => r.href.startsWith(`${COLD_CONTACT_BASE}/`))).toBe(true);
    const html = draw(PlannedCampaignDetail, { campaign: c, manager: true, people, back: { label: 'Cold outreach · Campaigns', href: COLD_CAMPAIGNS_HREF } });
    expect(html).toContain('Cold campaign');
    expect(html).toContain(`href="${COLD_CAMPAIGNS_HREF.replace('&', '&amp;')}"`);
    expect(html).toContain('Moved to CRM');
    expect(html).not.toContain('>Removed<');
    expect(html).toContain('Pause');
    expect(html).toContain('Exit');
    expect(html).not.toContain('/people/');
    // A cold contact's campaign follows its owner: no Reassign of the enrollment alone.
    const e = await prisma.enrollment.findFirstOrThrow({ where: { sandboxContactId: stays.id } });
    auth.requireUser.mockResolvedValue(await sessionOf(b.users.ria.id));
    expect(await reassignEnrollmentAction(fd({ enrollmentId: e.id, foUserId: b.users.karson.id }))).toEqual({ ok: false, error: expect.stringContaining('Give the contact to someone else from Cold outreach') });
  });

  it('B136: no email or phone is said in the studio, and those steps are skipped with the reason, not left to be done', async () => {
    const noEmail = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Ned', lastName: 'Noemail', email: null });
    const draft = coldDraft(b.pods.Alisa.id, [noEmail.id], [b.users.alisa.id]);
    const { campaign, review } = await publishColdCampaign(alisa, draft);
    expect(review.cold?.warnings).toEqual([{ reason: 'No email: email steps will be skipped', people: [{ id: noEmail.id, name: 'Ned Noemail' }] }]);
    await launch(campaign.id, draft.startDate);
    const tasks = await prisma.task.findMany({ where: { enrollment: { campaignId: campaign.id } }, orderBy: { actionIndex: 'asc' } });
    expect(tasks.map((t) => [t.action, t.state, t.skipReason])).toEqual([['EMAIL', 'SKIPPED', 'There is no email address for this contact'], ['CALL', 'PENDING', null]]);
  });

  it('Also in CRM: task generation skips a cold step with the reason (8.2), and nothing is sent', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const draft = coldDraft(b.pods.Alisa.id, [c.id], [b.users.alisa.id]);
    const { campaign } = await publishColdCampaign(alisa, draft);
    await launch(campaign.id, draft.startDate);
    const e = await prisma.enrollment.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await prisma.task.updateMany({ where: { enrollmentId: e.id }, data: { state: 'DONE', completedAt: new Date() } });
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { dnd: false, optedOut: false } });
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { crmMatchPersonId: 'person-01' } });
    expect((await advanceEnrollment(e.id, { actor: SYSTEM_ACTOR, now: noonOf(e.scheduleDates[1]), skipSync: true })).outcome).toBe('generated');
    expect(await prisma.task.findMany({ where: { enrollmentId: e.id, stepIndex: 1 } })).toEqual([expect.objectContaining({ state: 'SKIPPED', skipReason: 'This person is in the CRM now, so their outreach has stopped' })]);
  });

  it('N070: calls with no outcome yet are a warning in the studio and on the campaign before it starts', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Fay', lastName: 'Form' });
    await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
    const draft = coldDraft(b.pods.Alisa.id, [c.id], [b.users.alisa.id]);
    const { campaign, review } = await publishColdCampaign(alisa, draft);
    expect(review.cold?.warnings).toEqual([{ reason: 'A call has no outcome yet: fill in the form first', people: [{ id: c.id, name: 'Fay Form' }] }]);
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { pod: { select: { name: true } } } });
    expect(renderToStaticMarkup((await ColdCampaignNotes({ campaign: stored, launched: false, timezone: 'Europe/London' }))!)).toContain('A call has no outcome yet: fill in the form first');
  });

  it('N071: two people adding to one campaign at once both land: the lists are merged under the campaign lock', async () => {
    const draft = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id, b.users.karson.id]), alisa, { audience: 'SANDBOX' });
    const hers = await Promise.all([1, 2, 3].map(() => readyContact(b.users.alisa.id, b.pods.Alisa.id)));
    const his = await Promise.all([1, 2, 3].map(() => readyContact(b.users.karson.id, b.pods.Alisa.id)));
    const [a, k] = await Promise.all([addPeopleToCalendarCampaign(alisa, draft, hers.map((c) => c.id)), addPeopleToCalendarCampaign(karson, draft, his.map((c) => c.id))]);
    expect(a.ok && k.ok).toBe(true);
    expect(new Set((await prisma.campaign.findUniqueOrThrow({ where: { id: draft.id } })).personIds)).toEqual(new Set([...hers, ...his].map((c) => c.id)));
  });

  it('B137: a refused publish keeps what was typed: the draft is saved as it was', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const draft = coldDraft(b.pods.Alisa.id, [c.id], [b.users.alisa.id], { name: 'Typed with care' });
    const saved = await saveCampaignCalendar(draft, alisa, { audience: 'SANDBOX' });
    await expect(saveCampaignCalendar(draft, alisa, { id: saved.id, revision: saved.updatedAt.toISOString(), publish: true, fingerprint: 'stale', audience: 'SANDBOX' })).rejects.toThrow(/^Not published/);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: saved.id } })).toEqual(expect.objectContaining({ name: 'Typed with care', status: 'DRAFT', personIds: [c.id] }));
  });

  it('B144: a contact held by a campaign that has not started says so, and the campaign flags who would be left out now', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const twin = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Ann', lastName: 'Twin' });
    const draft = coldDraft(b.pods.Alisa.id, [c.id, twin.id], [b.users.alisa.id], { startDate: addDays(firstWorkingDay(), 7) });
    const { campaign } = await publishColdCampaign(alisa, draft);
    const rows = (await listContacts({ q: '', owner: 'all', status: 'active', ready: '', podId: '', source: '' }, b.users.alisa.id, 1)).rows;
    expect(rows.find((r) => r.id === c.id)?.campaign).toEqual(expect.objectContaining({ id: campaign.id, name: 'Cold Q4 Harbor', startsOn: expect.any(String) }));
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { dnd: false, optedOut: false } });
    await prisma.sandboxContact.update({ where: { id: twin.id }, data: { crmMatchPersonId: 'person-01' } });
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { pod: { select: { name: true } } } });
    const html = renderToStaticMarkup((await ColdCampaignNotes({ campaign: stored, launched: false, timezone: 'Europe/London' }))!);
    expect(html).toContain('One contact would be left out if it started now');
    expect(html).toContain('Ann Twin (already in the CRM)');
  });

  it('B198: a contact whose first step is still ahead reads Scheduled, and Next step is the earliest open one', async () => {
    const first = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Ava', lastName: 'First' });
    const later = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Zed', lastName: 'Later' });
    const draft = coldDraft(b.pods.Alisa.id, [first.id, later.id], [b.users.alisa.id], { defaultBatchSize: 1, fos: [{ id: b.users.alisa.id, batchSize: 1 }] });
    const { campaign } = await publishColdCampaign(alisa, draft);
    await launch(campaign.id, draft.startDate);
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    const people = await campaignPeoplePage(c, undefined, undefined);
    const html = draw(PlannedCampaignDetail, { campaign: c, manager: false, people });
    expect(html).toContain('Scheduled · starts');
    const now = people.rows.find((r) => r.startDate === draft.startDate)!;
    expect(now.nextStep).toMatch(/^Email 1 · /);
  });

  it('B199: the name limit is said, and an over-long name is refused, never cut', async () => {
    const long = 'x'.repeat(121);
    const parsed = CampaignDraftSchema.safeParse(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id], { name: long }));
    expect(parsed.success ? null : parsed.error.issues[0].message).toBe('Campaign names can be up to 120 characters. Shorten this one.');
    await expect(saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id], { name: long }), alisa, { audience: 'SANDBOX' })).rejects.toThrow('Campaign names can be up to 120 characters.');
  });

  it('B200: Cold outreach > Campaigns is the Campaigns screen: tabs, filters, search and New campaign, for cold campaigns only', async () => {
    const cold = await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id], { name: 'Cold one' }), alisa, { audience: 'SANDBOX' });
    await saveCampaignCalendar(coldDraft(b.pods.Alisa.id, [], [b.users.alisa.id], { name: 'CRM one' }), alisa, { audience: 'CRM' });
    const html = renderToStaticMarkup(await CampaignsScreen({ user: alisa, sp: {}, audience: 'SANDBOX', title: 'Cold campaigns', base: COLD_CONTACT_BASE, fixed: { tab: 'campaigns' }, tabParam: 'view', newHref: '/campaigns/new?audience=cold' }));
    expect(html).toContain('Cold one');
    expect(html).not.toContain('CRM one');
    expect(html).toContain('href="/campaigns/new?audience=cold"');
    expect(html).toContain('Search campaigns');
    expect(html).toContain(`${COLD_CONTACT_BASE}?tab=campaigns&amp;view=finished`);
    expect(html).toContain(`/campaigns/${cold.id}`);
    const crm = renderToStaticMarkup(await CampaignsScreen({ user: alisa, sp: {}, audience: 'CRM', title: 'All campaigns', base: '/campaigns', newHref: '/campaigns/new' }));
    expect(crm).toContain('CRM one');
    expect(crm).not.toContain('Cold one');
    // And a Junior FO gets Let go on his own contact's page, which the server always allowed.
    const { ContactActions } = await import('@/components/sandbox/contact-actions');
    const confirm = { title: 'Sure?' };
    const page = draw(ContactActions, { id: 'c1', name: 'Jane Doe', ready: false, unclaimed: false, mayWork: true, mayOptOut: true, mayMove: false, mayAssign: false, mayRelease: true, mayErase: false, users: [], confirms: { optOut: confirm, remove: confirm, erase: confirm } });
    expect(page).toContain('>Let go<');
    expect(page).not.toContain('>Assign<');
    const mine = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    auth.requireUser.mockResolvedValue(karson);
    const release = new FormData();
    release.append('ids', mine.id);
    release.set('userId', '');
    release.set(`owner:${mine.id}`, b.users.karson.id);
    expect(await sandboxActions.assignContactsAction(release)).toEqual(expect.objectContaining({ ok: true }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: mine.id } })).ownerId).toBeNull();
  });

  it('N100: an old sequence link opens a CRM campaign, never a cold one that shares the sequence', async () => {
    const crm = await prisma.campaign.create({ data: { name: 'CRM legacy', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [], startDate: '2026-10-01', status: 'COMPLETED', createdAt: new Date('2026-10-01T00:00:00Z') } });
    await prisma.campaign.create({ data: { name: 'Cold legacy', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [], startDate: '2026-11-03', status: 'SCHEDULED' } });
    await expect(RetiredSequencePage({ params: Promise.resolve({ id: b.sequence.id }) })).rejects.toThrow(`redirect:/campaigns/${crm.id}`);
  });

  it('cold contacts are only ever left out by the one cold audience check, which names each reason once (whoAndWhy)', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const issues = await coldAudienceIssues([c.id, 'missing-id'], { podId: b.pods.Leigh.id, podName: 'Pod Leigh', foIds: [] });
    expect(issues).toEqual([
      expect.objectContaining({ id: c.id, reason: `Owned by ${b.users.alisa.name} in another pod (Pod Alisa)` }),
      expect.objectContaining({ id: 'missing-id', reason: 'No longer in Cold outreach' }),
    ]);
  });
});
