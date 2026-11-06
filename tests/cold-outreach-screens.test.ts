import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { coldOutreachRedirect } from '@/lib/cold-outreach-paths';
import { COLD_CAMPAIGNS_HREF, COLD_CONTACT_BASE, COLD_FROM_BELLWETHER_HREF, COLD_MOVES_HREF, coldMoveHref, coldRef, subjectHref } from '@/lib/subject';
import { COLD_TASKS_HREF } from '@/lib/tasks-query';
import { campaignTitle } from '@/lib/campaigns-query';
import { coldCues } from '@/lib/sandbox/cues';
import { contactPathStep, pathFrom, repPath } from '@/lib/sandbox/path';
import { listPushes } from '@/lib/sandbox/pushes-query';
import { StepStrip } from '@/components/sandbox/step-strip';
import { SubjectBadges } from '@/components/subject-badges';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { sessionOf } from './helpers/cold-campaign';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

/**
 * Stage S10 (cold outreach W8): the section's screens, the rename, Settings, search and the step strip.
 * One test per bug id, named after it.
 */
describe('Cold outreach: the address and the rename (S10)', () => {
  it('every /sandbox address redirects to its /cold-outreach page, keeping the query string', () => {
    expect(coldOutreachRedirect('/sandbox', '')).toBe('/cold-outreach');
    expect(coldOutreachRedirect('/sandbox/', '')).toBe('/cold-outreach');
    expect(coldOutreachRedirect('/sandbox', '?owner=mine&q=jane')).toBe('/cold-outreach?owner=mine&q=jane');
    expect(coldOutreachRedirect('/sandbox', '?tab=contacts&status=moved')).toBe('/cold-outreach?status=moved');
    expect(coldOutreachRedirect('/sandbox', '?tab=work')).toBe('/cold-outreach/tasks');
    expect(coldOutreachRedirect('/sandbox', '?tab=moves&state=failed')).toBe('/cold-outreach/moves?state=failed');
    expect(coldOutreachRedirect('/sandbox', '?tab=campaigns&view=finished&q=harbor')).toBe('/cold-outreach/campaigns?q=harbor&tab=finished');
    expect(coldOutreachRedirect('/sandbox/c-123', '?move=1')).toBe('/cold-outreach/c-123?move=1');
    expect(coldOutreachRedirect('/sandbox/moves/m-1', '')).toBe('/cold-outreach/moves/m-1');
    expect(coldOutreachRedirect('/sandbox/campaigns/k-9', '?page=2')).toBe('/campaigns/k-9?page=2');
    // Only the old section's own addresses move.
    expect(coldOutreachRedirect('/sandboxes', '')).toBeNull();
    expect(coldOutreachRedirect('/tasks', '?audience=cold')).toBeNull();
    expect(coldOutreachRedirect('/cold-outreach', '')).toBeNull();
  });

  it('the middleware answers an old address with a 307 to the new one, before the sign-in check', async () => {
    const { middleware } = await import('@/middleware');
    const { NextRequest } = await import('next/server');
    const res = middleware(new NextRequest('http://cadence.local/sandbox/abc?move=1'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search).toBe('/cold-outreach/abc?move=1');
  });

  it('every cold link is built under /cold-outreach: contacts, Tasks, Campaigns, Moves, From Bellwether', () => {
    expect(COLD_CONTACT_BASE).toBe('/cold-outreach');
    expect(subjectHref(coldRef('c1'))).toBe('/cold-outreach/c1');
    expect(COLD_TASKS_HREF).toBe('/cold-outreach/tasks');
    expect(COLD_CAMPAIGNS_HREF).toBe('/cold-outreach/campaigns');
    expect(COLD_MOVES_HREF).toBe('/cold-outreach/moves');
    expect(coldMoveHref('m1')).toBe('/cold-outreach/moves/m1');
    expect(COLD_FROM_BELLWETHER_HREF).toBe('/cold-outreach/from-bellwether');
  });
});

describe('Cold outreach screens (S10)', () => {
  let b: Basics;
  let alisa: SessionUser;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    alisa = await sessionOf(b.users.alisa.id);
  });

  it('B115: a cold campaign\'s page is titled "Q4 Harbor · Campaigns · Cold outreach", a CRM one\'s "· Campaigns"', async () => {
    const cold = await prisma.campaign.create({ data: { name: 'Q4 Harbor', audience: 'SANDBOX', podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-09', createdById: b.users.alisa.id } });
    const crm = await prisma.campaign.create({ data: { name: 'Spring push', audience: 'CRM', podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-09', createdById: b.users.alisa.id } });
    expect(await campaignTitle(cold.id)).toBe('Q4 Harbor · Campaigns · Cold outreach');
    expect(await campaignTitle(crm.id)).toBe('Spring push · Campaigns');
    const { generateMetadata } = await import('@/app/(app)/cold-outreach/[id]/page');
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    expect(await generateMetadata({ params: Promise.resolve({ id: c.id }) })).toEqual({ title: 'Jane Doe · Cold outreach' });
  });

  it('B057: From Bellwether lists every push with its counts, and each contact with its result and why', async () => {
    const added = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    const unclaimed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Bob', lastName: 'Lee', ownerId: null, podId: null });
    await prisma.bellwetherPush.create({ data: {
      idempotencyKey: 'k1', bodyHash: 'h', state: 'DONE', pushedByEmail: 'alisa@cadence.local', ownerId: b.users.alisa.id, contactCount: 4,
      response: { results: [{ bellwetherContactId: 'bw-4', result: 'rejected', reason: 'suppressed', detail: 'This person asked not to be contacted.', warnings: [] }] },
      items: { create: [
        { bellwetherContactId: 'bw-1', result: 'created', sandboxContactId: added.id },
        { bellwetherContactId: 'bw-2', result: 'created', sandboxContactId: unclaimed.id },
        { bellwetherContactId: 'bw-3', result: 'already_in_crm', crmPersonId: (await prisma.personCache.findFirstOrThrow()).id },
        { bellwetherContactId: 'bw-4', result: 'rejected', reason: 'suppressed' },
      ] },
    } });
    const { rows, total } = await listPushes(1);
    expect(total).toBe(1);
    expect(rows[0]).toEqual(expect.objectContaining({ added: 2, unclaimed: 1, inCrm: 1, refused: 1, merged: 0 }));
    expect(rows[0].by).toMatch(/^Alisa/);
    const byName = new Map(rows[0].contacts.map((c) => [c.name, c]));
    expect(byName.get('Jane Doe')).toEqual(expect.objectContaining({ result: 'Added', href: `/cold-outreach/${added.id}` }));
    expect(byName.get('Bob Lee')).toEqual(expect.objectContaining({ result: 'Added, unclaimed', tone: 'amber' }));
    expect(byName.get('Bellwether contact bw-4')).toEqual(expect.objectContaining({ result: 'Refused', why: 'This person asked not to be contacted.' }));
  });

  it('PLAN 4.0: one badge per contact from one function, in the table\'s words, and the warning chips beside it', async () => {
    const today = '2026-11-06';
    const unclaimed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    const bare = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { badPhone: true, emailVerification: 'risky' });
    const stepped = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { possibleBounceAt: new Date('2026-11-04T10:00:00Z') });
    await prisma.nextAction.create({ data: { sandboxContactId: stepped.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-05', audience: 'SANDBOX' } });
    const opted = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'OPTED_OUT', optedOutAt: new Date('2026-11-03T12:00:00Z') });
    const cues = await coldCues([unclaimed.id, bare.id, stepped.id, opted.id], { today });
    expect(cues.get(unclaimed.id)!.badge).toEqual(expect.objectContaining({ label: 'Unclaimed', tone: 'amber' }));
    expect(cues.get(bare.id)!.badge).toEqual(expect.objectContaining({ label: 'No next step', tone: 'amber' }));
    expect(cues.get(bare.id)!.chips.map((c) => c.label)).toEqual(['Wrong number', 'Email risky']);
    // N083: overdue is red, and the next step is labelled.
    expect(cues.get(stepped.id)!.badge).toEqual(expect.objectContaining({ label: 'Call · Thu 5 Nov', tone: 'red' }));
    expect(cues.get(stepped.id)!.next).toEqual(expect.objectContaining({ label: 'Call', due: '2026-11-05', overdue: true }));
    expect(cues.get(stepped.id)!.chips.map((c) => c.label)).toEqual(['Possible bounce']);
    expect(cues.get(opted.id)!.badge).toEqual(expect.objectContaining({ label: 'Do not contact · 3 Nov 2026', tone: 'red' }));
    const html = renderToStaticMarkup(createElement(SubjectBadges, { badge: cues.get(bare.id)!.badge, chips: cues.get(bare.id)!.chips }));
    expect(html).toContain('No next step');
    expect(html).toContain('Wrong number');
  });

  it('the step strip counts the rep\'s path for me, highlights where I am most behind, and greys out when nothing waits', async () => {
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const path = await repPath(alisa);
    expect(path.steps.map((s) => [s.key, s.count])).toEqual([['claim', 2], ['work', 0], ['form', 0], ['next', 1], ['move', 0]]);
    expect(path.behind).toBe('claim');
    const html = renderToStaticMarkup(createElement(StepStrip, { path }));
    expect(html).toContain('2 to claim');
    expect(html).toContain('1 with no next step');
    expect(html).toContain('href="/cold-outreach?view=unclaimed"');
    // A form waiting blocks every call, so it is the step to catch up on first.
    expect(pathFrom({ claim: 5, work: 9, form: 1, next: 3, move: 0 }).behind).toBe('form');
    const idle = renderToStaticMarkup(createElement(StepStrip, { path: pathFrom({ claim: 0, work: 0, form: 0, next: 0, move: 0 }) }));
    expect(idle).toContain('Nothing waiting. New contacts arrive from Bellwether.');
    expect(contactPathStep({ state: 'unclaimed', formDue: false, worked: false })).toBe('claim');
    expect(contactPathStep({ state: 'no_next_step', formDue: false, worked: false })).toBe('work');
    expect(contactPathStep({ state: 'no_next_step', formDue: false, worked: true })).toBe('next');
    expect(contactPathStep({ state: 'ready_to_move', formDue: true, worked: true })).toBe('form');
  });
});
