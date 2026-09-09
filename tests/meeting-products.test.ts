import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { enrichmentQueue } from '@/lib/enrichment';
import type { SessionUser } from '@/lib/auth/current-user';
import { PRODUCTS } from '@/lib/workspace';
import { enrollPeople } from '@/lib/engine';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * Two things the owner asked for late: tagging a meeting with the products it was about, and an
 * enrichment queue that knows a contact with no company or LinkedIn is as stuck as one with no
 * email.
 */

const at = (date: string) => new Date(`${date}T10:00:00Z`);
const session = (u: { id: string; role: string; email: string; name: string; twentyMemberId: string | null }, podIds: string[]): SessionUser =>
  ({ ...u, podIds, timezone: 'America/Chicago' }) as unknown as SessionUser;

describe('meeting products and what counts as missing', () => {
  let b: Basics;
  let admin: SessionUser;

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    admin = session(b.users.ria, []);
  });

  it('a meeting carries several products, in the order the list defines', async () => {
    const meeting = await prisma.meeting.create({
      data: { title: 'Quarterly review', sourceUrl: 'https://example.com/r.mp4', provider: 'FILE', occurredAt: at('2026-09-08'), createdById: b.users.alisa.id },
    });
    expect(meeting.products).toEqual([]);

    // Tagged out of order, stored in the list's order, so two meetings with the same tags read
    // the same wherever they are shown.
    const tagged = await prisma.meeting.update({
      where: { id: meeting.id },
      data: { products: PRODUCTS.filter((p) => ['GLYNAC', 'PHH'].includes(p)) },
    });
    expect(tagged.products).toEqual(['PHH', 'GLYNAC']);
    expect(PRODUCTS).toEqual(['PHH', 'ACUBOOTH', 'GLYNAC']);
  });

  it('a contact with no company or LinkedIn is critical, not merely useful', async () => {
    await prisma.companyCache.create({ data: { id: 'co-gap', name: 'Gap Ltd' } });
    await prisma.personCache.create({
      data: { id: 'person-gap', firstName: 'No', lastName: 'Details', email: 'no.details@gap.example', phone: '+14155550123', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
    });

    const queue = await enrichmentQueue(admin);
    const person = queue.find((item) => item.id === 'person-gap');
    expect(person).toBeTruthy();
    const critical = person!.gaps.filter((g) => g.priority === 'critical').map((g) => g.field);
    expect(critical).toContain('companyId');
    expect(critical).toContain('linkedinUrl');
    // Their email and phone are fine, so those are not flagged at all.
    expect(person!.gaps.map((g) => g.field)).not.toContain('email');
  });

  it('an account needs a website and a LinkedIn; AUM and the rest are worth having', async () => {
    const queue = await enrichmentQueue(admin);
    const account = queue.find((item) => item.id === 'co-gap');
    expect(account).toBeTruthy();
    const byPriority = Object.fromEntries(account!.gaps.map((g) => [g.field, g.priority]));
    expect(byPriority.domain).toBe('critical');
    expect(byPriority.linkedinUrl).toBe('critical');
    expect(byPriority.aum).toBe('useful');
    expect(byPriority.industry).toBe('useful');
    expect(byPriority.employees).toBe('useful');
  });

  it('enrolling nobody leaves the queue unchanged', async () => {
    const before = (await enrichmentQueue(admin)).length;
    await enrollPeople(
      { personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR },
      { now: at('2026-09-07') },
    );
    expect((await enrichmentQueue(admin)).length).toBe(before);
  });
});
