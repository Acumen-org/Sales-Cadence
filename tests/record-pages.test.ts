import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { cleanNote, cleanTitle, kindOf } from '@/lib/feed';
import { personFeed, touchTitle } from '@/lib/person-feed';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { sessionOf } from './helpers/cold-campaign';

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => '/people', useSearchParams: () => new URLSearchParams(), redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('not found'); } }));
const { default: PersonPage } = await import('@/app/(app)/people/[id]/page');
const { default: AccountPage } = await import('@/app/(app)/accounts/[id]/page');

/**
 * Owner, 13 Nov 2026: the CRM person and account pages were a stack of boxes, and Activity and Emails
 * ran every kind of event together. One feed by day with a word and colour per kind, filled fields
 * only, Add LinkedIn at the top, six account tabs.
 */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
let b: Basics;
let alisa: SessionUser;

describe('the activity feed reads in plain words', () => {
  it('takes the machine lines out of the notes Cadence writes, and keeps the step and outcome as fields', () => {
    const note = cleanNote('Call 1 (call) completed by Alisa Senior in Cadence.\nSequence "Default outbound", step 2 (day 3).\nOutcome: Left voicemail.\n\nCall back Thursday.\nSource: MANUAL.');
    expect(note).toEqual({ body: 'Call back Thursday.', fields: [{ label: 'Campaign', value: 'Default outbound · step 2' }, { label: 'Outcome', value: 'Left voicemail' }] });
    expect(cleanNote('Source: OBSERVED_MESSAGE (message:x).').body).toBeNull();
    expect(cleanTitle('[Cadence] Email 2 sent by Alisa')).toBe('Email 2 sent by Alisa');
    expect(cleanTitle('[Email] Outbound email: Intro')).toBe('Outbound email: Intro');
    expect(touchTitle('Email sent: A quick idea')).toBe('A quick idea');
    expect(['CALL', 'EMAIL', 'LINKEDIN_CONNECT', 'MEETING', 'NOTE', 'STATE'].map(kindOf)).toEqual(['call', 'email', 'linkedin', 'meeting', 'note', 'campaign']);
  });

  it('shows a step once: Cadence\'s own CRM note of it is hidden, and a step done by hand keeps its outcome and the rep\'s words', () => {
    const at = new Date('2026-11-08T10:00:00Z');
    const task = { id: 'k1', label: 'Call 1', action: 'CALL', chosenAction: null, state: 'DONE', disposition: 'voicemail', skipReason: null, note: 'Call back Thursday.', completedAt: at, updatedAt: at, evidenceId: null, twentyNoteId: 'n1', stepIndex: 1, enrollmentId: 'e1', fo: { name: 'Alisa Senior' } } as never;
    const feed = personFeed({
      touches: [
        { id: 't1', externalId: 'task:k1', channel: 'CALL', direction: 'OUTBOUND', occurredAt: at, summary: 'Call 1 (marked done manually)', actorLabel: 'Cadence' },
        { id: 't2', externalId: 'note:n1:person:p', channel: 'CALL', direction: 'OUTBOUND', occurredAt: at, summary: '[Cadence] Call 1 made by Alisa', actorLabel: null },
      ] as never,
      notes: [{ id: 'n1', title: '[Cadence] Call 1 made by Alisa', bodyMarkdown: 'Source: MANUAL.', createdAt: at.toISOString(), createdByName: null }] as never,
      tasks: [task], audit: [],
      sequenceOf: () => 'Default outbound', outcomeLabel: (k) => (k === 'voicemail' ? 'Left voicemail' : k),
    });
    expect(feed).toHaveLength(1);
    expect(feed[0]).toEqual(expect.objectContaining({ kind: 'call', label: 'Call step', title: 'Call 1 done', who: 'Alisa Senior', body: 'Call back Thursday.' }));
    expect(feed[0].fields).toEqual(expect.arrayContaining([{ label: 'Outcome', value: 'Left voicemail' }, { label: 'Campaign', value: 'Default outbound · step 2' }]));
  });
});

describe('the person and account pages', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    alisa = await sessionOf(b.users.alisa.id);
    auth.requireUser.mockResolvedValue(alisa);
  });

  it('a person with no LinkedIn link gets Add LinkedIn in the header; no empty CRM rows, no checklist of boxes', async () => {
    const person = await prisma.personCache.findFirstOrThrow({ where: { deletedAt: null, podOwner: { not: null } } });
    await prisma.personCache.update({ where: { id: person.id }, data: { linkedinUrl: null, linkedinKey: null, bookingId: null, meetingUrl: null } });
    const html = renderToStaticMarkup(await PersonPage({ params: Promise.resolve({ id: person.id }), searchParams: Promise.resolve({}) }));
    const words = text(html);
    expect(words).toContain('Add LinkedIn');
    for (const card of ['Task', 'Recent activity', 'CRM profile', 'Contact details', 'LinkedIn']) expect(words, card).toContain(card);
    for (const gone of ['Classification', 'CRM activity details', 'Ownership', 'All people']) expect(words, gone).not.toContain(gone);
    // A field the record does not have is left out, not shown as a dash.
    expect(words).not.toMatch(/BOOKING|Booking/);
  });

  it('an account has six tabs, its people in a list or by title, and one activity feed; old tab links still open', async () => {
    const someone = await prisma.personCache.findFirstOrThrow({ where: { deletedAt: null, companyId: { not: null }, podOwner: { not: null } } });
    const company = { id: someone.companyId! };
    auth.requireUser.mockResolvedValue({ ...alisa, role: 'ADMIN' });
    const draw = async (sp: Record<string, string>) => text(renderToStaticMarkup(await AccountPage({ params: Promise.resolve({ id: company.id }), searchParams: Promise.resolve(sp) })));
    const overview = await draw({});
    for (const t of ['Overview', 'People', 'Activity', 'Campaigns', 'Meetings', 'Tasks']) expect(overview).toContain(t);
    expect(overview).not.toContain('People by title');
    expect(overview).not.toContain('Timeline');
    expect(await draw({ tab: 'relationships' })).toMatch(/(Executive|Leadership|Management|Other) titles/);
    expect(await draw({ tab: 'people' })).toContain('By title');
    expect(await draw({ tab: 'timeline' })).toContain('Activity');
  });
});
