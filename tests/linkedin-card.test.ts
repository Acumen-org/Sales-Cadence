import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { linkedinSubjectView } from '@/lib/linkedin/subject-view';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const { addPersonLinkedinLinkAction } = await import('@/lib/actions/linkedin-links');

const asUser = (user: User, podIds: string[] = []): SessionUser => ({ ...user, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/** The LinkedIn card on a person's and a cold contact's page, and adding a CRM person's LinkedIn link. */
describe('LinkedIn card', () => {
  let b: Basics;
  const mock = getMockTwentyClient();

  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    mock.writes = [];
    auth.user.mockResolvedValue(asUser(b.users.alisa, [b.pods.Alisa.id]));
    await prisma.linkedInAccount.createMany({ data: [{ id: 'acc-leader', name: 'Sam Leader' }, { id: 'acc-firm', name: 'Acme Firm' }] });
  });

  it("shows each account's standing with a CRM person, and their open LinkedIn tasks", async () => {
    const key = 'linkedin.com/in/jane-prospect';
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { linkedinUrl: `https://www.${key}`, linkedinKey: key } });
    await prisma.linkedInLink.create({ data: { accountId: 'acc-leader', profileKey: key, personId: 'person-01', status: 'PENDING', invitedAt: new Date('2026-11-03T12:00:00Z'), invitedByUserId: b.users.alisa.id, resends: 1 } });
    const accepted = await prisma.linkedInLink.create({ data: { accountId: 'acc-firm', profileKey: key, personId: 'person-01', status: 'ACCEPTED', invitedAt: new Date('2026-11-01T12:00:00Z'), acceptedAt: new Date('2026-11-06T12:00:00Z'), lastSentAt: new Date('2026-11-07T12:00:00Z'), lastReplyAt: new Date('2026-11-08T12:00:00Z') } });
    await prisma.linkedInFollowUp.create({ data: { kind: 'MESSAGE', trigger: 'replied', triggeredAt: new Date('2026-11-08T12:00:00Z'), linkId: accepted.id, accountId: 'acc-firm', personId: 'person-01', foUserId: b.users.alisa.id, dueDate: '2026-11-09' } });
    await prisma.linkedInFollowUp.create({ data: { kind: 'MESSAGE', trigger: 'accepted', triggeredAt: new Date('2026-11-06T12:00:00Z'), linkId: accepted.id, accountId: 'acc-firm', personId: 'person-01', state: 'DONE' } });

    const view = await linkedinSubjectView({ personId: 'person-01' }, 'UTC', new Date('2026-11-12T12:00:00Z'));
    expect(view.accounts.map((a) => a.accountName)).toEqual(['Acme Firm', 'Sam Leader']);
    const [firm, leader] = view.accounts;
    expect(leader).toEqual(expect.objectContaining({ status: 'PENDING', statusLine: `Request sent 3 Nov by ${b.users.alisa.name}`, resendLine: 'Sent again once', lastSent: null, tasks: [] }));
    expect(firm).toEqual(expect.objectContaining({ status: 'ACCEPTED', statusLine: 'Connected since 6 Nov', resendLine: null, lastSent: '7 Nov', lastReply: '8 Nov' }));
    expect(firm.tasks).toEqual([expect.objectContaining({ label: 'Reply on LinkedIn', dueDate: '2026-11-09', overdue: true, owner: b.users.alisa.name })]);
  });

  it("shows a cold contact's own links only, and nothing for someone not seen", async () => {
    const key = 'linkedin.com/in/cold-one';
    const contact = await prisma.sandboxContact.create({ data: { source: 'MANUAL', firstName: 'Cold', lastName: 'One', linkedinUrl: key } });
    const withdrawn = await prisma.linkedInLink.create({ data: { accountId: 'acc-leader', profileKey: key, sandboxContactId: contact.id, status: 'WITHDRAWN', invitedAt: new Date('2026-11-01T12:00:00Z'), withdrawnAt: new Date('2026-11-20T12:00:00Z') } });
    await prisma.linkedInFollowUp.create({ data: { kind: 'RESEND', trigger: 'withdrawn', triggeredAt: new Date('2026-11-20T12:00:00Z'), linkId: withdrawn.id, accountId: 'acc-leader', sandboxContactId: contact.id } });
    // Once moved to the CRM, a link belongs to the person, not to the cold contact.
    await prisma.linkedInLink.create({ data: { accountId: 'acc-firm', profileKey: key, sandboxContactId: contact.id, personId: 'person-02', status: 'ACCEPTED' } });

    const view = await linkedinSubjectView({ sandboxContactId: contact.id }, 'UTC');
    expect(view.accounts).toHaveLength(1);
    expect(view.accounts[0]).toEqual(expect.objectContaining({ accountName: 'Sam Leader', status: 'WITHDRAWN', statusLine: 'Request withdrawn 20 Nov' }));
    expect(view.accounts[0].tasks).toEqual([expect.objectContaining({ label: 'Send the connection request again', dueDate: null, owner: null })]);

    expect((await linkedinSubjectView({ personId: 'person-03' }, 'UTC')).accounts).toEqual([]);
  });

  it("adds a CRM person's LinkedIn link to the CRM and to Cadence", async () => {
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { linkedinUrl: null, linkedinKey: null, ownerMemberId: b.users.alisa.twentyMemberId } });
    const r = await addPersonLinkedinLinkAction(form({ personId: 'person-01', linkedinUrl: 'https://uk.linkedin.com/in/Jane-Doe/?trk=x' }));
    expect(r).toEqual({ ok: true, message: 'LinkedIn link saved.' });
    expect(mock.writes).toContainEqual({ op: 'enrichPerson', id: 'person-01', patch: { linkedinUrl: 'https://www.linkedin.com/in/jane-doe' } });
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } })).toEqual(expect.objectContaining({ linkedinUrl: 'https://www.linkedin.com/in/jane-doe', linkedinKey: 'linkedin.com/in/jane-doe' }));
    expect(await prisma.auditLog.count({ where: { entityType: 'person', entityId: 'person-01', action: 'linkedin_link_added', actorId: b.users.alisa.id } })).toBe(1);
  });

  it('refuses a link that is not a profile, one another person has, and Biz Ops', async () => {
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { linkedinUrl: null, linkedinKey: null, ownerMemberId: b.users.alisa.twentyMemberId } });
    await prisma.personCache.update({ where: { id: 'person-02' }, data: { linkedinUrl: 'https://www.linkedin.com/in/taken', linkedinKey: 'linkedin.com/in/taken' } });

    const bad = await addPersonLinkedinLinkAction(form({ personId: 'person-01', linkedinUrl: 'https://www.linkedin.com/company/acme' }));
    expect(bad.ok).toBe(false);
    const dup = await addPersonLinkedinLinkAction(form({ personId: 'person-01', linkedinUrl: 'linkedin.com/in/Taken' }));
    expect(dup).toEqual({ ok: false, error: expect.stringContaining('already has this LinkedIn link') });
    auth.user.mockResolvedValue({ ...asUser(b.users.daniel, [b.pods.Leigh.id]), role: 'BIZ_OPS' });
    expect((await addPersonLinkedinLinkAction(form({ personId: 'person-01', linkedinUrl: 'linkedin.com/in/jane-doe' }))).ok).toBe(false);

    expect(mock.writes.filter((w) => w.op === 'enrichPerson')).toEqual([]);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } })).linkedinKey).toBeNull();
  });
});
