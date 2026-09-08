import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { buildHome, meetingsThisWeek, repliesThisWeek } from '@/lib/home-query';
import { myOwnershipCounts } from '@/lib/accounts-query';
import { weekRange } from '@/lib/dates';
import { enrollPeople } from '@/lib/engine';
import { saveSettingsSection, getSettings } from '@/lib/settings';
import { resetDb, seedBasics, type Basics } from './helpers/db';

// 2026-09-08 is a Tuesday, so this week is Sun 6th to Sat 12th.
const TUESDAY = new Date('2026-09-08T10:00:00Z');
const DOMAINS = ['acumen-strategy.com', 'prairie-hill.com'];

function sessionUser(
  u: { id: string; email: string; name: string; role: 'ADMIN' | 'SENIOR_FO' | 'JUNIOR_FO'; timezone: string; twentyMemberId: string | null; dailyCap: number | null },
  podIds: string[],
): SessionUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) };
}

async function touch(personId: string, at: string, direction: 'INBOUND' | 'OUTBOUND', channel: 'EMAIL' | 'CALL' = 'EMAIL') {
  await prisma.touch.create({
    data: {
      personId,
      channel,
      direction,
      occurredAt: new Date(at),
      summary: `${direction} ${channel} ${at}`,
      externalId: `test:${personId}:${direction}:${channel}:${at}`,
      actorLabel: 'Twenty',
    },
  });
}

describe('home: this week, Sunday to Saturday', () => {
  let b: Basics;
  let week: ReturnType<typeof weekRange>;

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    week = weekRange('2026-09-08', 'Europe/London');
    const rules = (await getSettings()).rules;
    await saveSettingsSection('rules', { ...rules, internalDomains: DOMAINS });

    // person-01 is Alisa's (mock fixture owner), enrolled with her as the FO.
    await enrollPeople(
      { personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR },
      { now: TUESDAY },
    );
  });

  it('counts inbound emails inside the week and ignores the ones outside it', async () => {
    await touch('person-01', '2026-09-06T08:00:00Z', 'INBOUND'); // Sunday, in
    await touch('person-01', '2026-09-08T09:00:00Z', 'INBOUND'); // Tuesday, in
    await touch('person-01', '2026-09-05T21:00:00Z', 'INBOUND'); // Sat 22:00 London, last week
    await touch('person-01', '2026-09-05T23:30:00Z', 'INBOUND'); // Sun 00:30 London, in
    await touch('person-01', '2026-09-13T09:00:00Z', 'INBOUND'); // next Sunday, out
    await touch('person-01', '2026-09-08T11:00:00Z', 'OUTBOUND'); // ours, not a reply
    await touch('person-01', '2026-09-08T12:00:00Z', 'INBOUND', 'CALL'); // not an email

    const admin = sessionUser(b.users.ria, []);
    const r = await repliesThisWeek(admin, week, 25);
    expect(r.total).toBe(3);
    // Newest first, and it carries the person and the FO for the row.
    expect(r.rows[0].at.toISOString()).toBe('2026-09-08T09:00:00.000Z');
    expect(r.rows[0].name).toBe('Nina Halvorsen');
    expect(r.rows[0].foName).toBe('Alisa Marsh');
  });

  it('shows a junior only replies for people assigned to them', async () => {
    const daniel = sessionUser(b.users.daniel, [b.pods.Leigh.id]);
    expect((await repliesThisWeek(daniel, week, 25)).total).toBe(0);
    const alisa = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    expect((await repliesThisWeek(alisa, week, 25)).total).toBe(3);
  });

  it('counts a meeting only when somebody outside our domains attended', async () => {
    const internalOnly = await prisma.meeting.create({
      data: {
        title: 'Internal pipeline review',
        provider: 'TEAMS',
        sourceUrl: 'https://teams.microsoft.com/l/meetup-join/x',
        occurredAt: new Date('2026-09-08T09:00:00Z'),
        createdById: b.users.alisa.id,
        attendees: {
          create: [
            { email: 'alisa@acumen-strategy.com', external: false, host: true, userId: b.users.alisa.id },
            { email: 'karson@acumen-strategy.com', external: false },
          ],
        },
      },
    });
    await prisma.meeting.create({
      data: {
        title: 'Nina Halvorsen intro',
        provider: 'FILE',
        sourceUrl: 'https://files.example/rec.mp4',
        mediaUrl: 'https://files.example/rec.mp4',
        occurredAt: new Date('2026-09-09T09:00:00Z'),
        createdById: b.users.alisa.id,
        attendees: {
          create: [
            { email: 'alisa@acumen-strategy.com', external: false, host: true, userId: b.users.alisa.id },
            { email: 'ann@prospect.example', external: true, personId: 'person-01' },
          ],
        },
      },
    });
    // Last week: real prospect meeting, but outside the window.
    await prisma.meeting.create({
      data: {
        title: 'Last week',
        provider: 'ZOOM',
        sourceUrl: 'https://x.zoom.us/rec/share/y',
        occurredAt: new Date('2026-09-02T09:00:00Z'),
        createdById: b.users.alisa.id,
        attendees: { create: [{ email: 'someone@prospect.example', external: true }] },
      },
    });

    const admin = sessionUser(b.users.ria, []);
    const m = await meetingsThisWeek(admin, week, DOMAINS, 25);
    expect(m.rows.map((r) => r.title)).toEqual(['Nina Halvorsen intro']);
    expect(m.rows[0].externals).toBe(1);
    expect(m.rows[0].href).toMatch(/^\/meetings\//);
    expect(m.total).toBe(1);
    // The internal one is excluded on attendee domains, not on anything stored per meeting.
    expect(await prisma.meeting.count({ where: { id: internalOnly.id } })).toBe(1);
  });

  it('re-checks externality against the current domain list, so the setting is retroactive', async () => {
    const admin = sessionUser(b.users.ria, []);
    // Treat the prospect domain as ours: the meeting stops counting.
    const narrowed = await meetingsThisWeek(admin, week, [...DOMAINS, 'prospect.example'], 25);
    expect(narrowed.total).toBe(0);
    // Drop our own domain: the internal meeting starts counting.
    const widened = await meetingsThisWeek(admin, week, [], 25);
    expect(widened.rows.map((r) => r.title)).toEqual(['Nina Halvorsen intro', 'Internal pipeline review']);
  });

  it('includes a meeting a sequence detected, and attributes it to the FO', async () => {
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01' } });
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { meetingAt: new Date('2026-09-10T14:00:00Z'), status: 'MEETING' } });
    const alisa = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    const m = await meetingsThisWeek(alisa, week, DOMAINS, 25);
    expect(m.rows.map((r) => r.source)).toEqual(['sequence', 'meeting']);
    expect(m.rows[0].title).toBe('Meeting booked with Nina Halvorsen');
    // Not this FO's enrollment: not their meeting.
    const daniel = sessionUser(b.users.daniel, [b.pods.Leigh.id]);
    expect((await meetingsThisWeek(daniel, week, DOMAINS, 25)).total).toBe(0);
  });

  it('counts what a user owns: accounts and relationships', async () => {
    const alisa = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    const mine = await myOwnershipCounts(alisa);
    const owned = await prisma.personCache.count({ where: { deletedAt: null, ownerMemberId: 'wm-alisa' } });
    expect(mine.relationships).toBe(owned);
    expect(mine.accounts).toBeGreaterThan(0);

    // Owning an account with nobody in it still counts as an account.
    const empty = await prisma.companyCache.create({ data: { id: 'co-empty', name: 'Empty Co', ownerMemberId: 'wm-alisa' } });
    const after = await myOwnershipCounts(alisa);
    expect(after.accounts).toBe(mine.accounts + 1);
    await prisma.companyCache.delete({ where: { id: empty.id } });
  });

  it('assembles Home with the week label and both boxes', async () => {
    const alisa = sessionUser(b.users.alisa, [b.pods.Alisa.id]);
    const home = await buildHome(alisa, TUESDAY);
    expect(home.today).toBe('2026-09-08');
    expect([home.week.from, home.week.to]).toEqual(['2026-09-06', '2026-09-12']);
    expect(home.replies.total).toBe(3);
    expect(home.meetings.total).toBe(2);
    expect(home.my.accounts).toBeGreaterThan(0);
    expect(home.my.relationships).toBeGreaterThan(0);
    // Team figures are this week, not a rolling 7 days.
    const row = home.team.find((t) => t.id === b.users.alisa.id)!;
    expect(row.meetings).toBe(1);
    expect(row.name).toBe('Alisa Marsh');
  });

  it('gives a junior no team table', async () => {
    const home = await buildHome(sessionUser(b.users.karson, [b.pods.Alisa.id]), TUESDAY);
    expect(home.team).toEqual([]);
    expect(home.needsReview).toBe(0);
  });
});
