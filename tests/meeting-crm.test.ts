import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { meetingNote, removeMeetingFromCrm, syncMeetingToCrm } from '@/lib/meetings/crm';
import { classifyNoteTitle } from '@/lib/engine/matching';
import { getSettings } from '@/lib/settings';

/**
 * Twenty keeps the record: a meeting added in Cadence is a note on its contacts and its account,
 * rewritten when the meeting changes and removed when it is deleted.
 */
describe('meetings recorded in Twenty', () => {
  let b: Basics;
  const mock = getMockTwentyClient();

  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    mock.writes = [];
  });

  const meeting = () => prisma.meeting.create({ data: {
    title: 'Pricing walk-through', sourceUrl: 'https://www.loom.com/share/abc123', occurredAt: new Date('2027-03-04T16:00:00Z'), durationSec: 1800,
    bookedById: b.users.karson.id, products: ['PHH'], companyId: 'co-01', companyName: 'Acme',
    attendees: { create: [{ personId: 'person-01', email: 'p1@prospect.example', name: 'Pat One', external: true }, { personId: 'person-02', email: 'p2@prospect.example', name: 'Pam Two', external: true }, { email: 'karson@cadence.local', name: 'Karson', external: false }] },
  } });

  it('writes one note on every contact and the account, with what the meeting was', async () => {
    const m = await meeting();
    const id = await syncMeetingToCrm(m.id);
    expect(id).toBeTruthy();
    const write = mock.writes.find((w) => w.op === 'createNote');
    expect(write).toMatchObject({ op: 'createNote', input: { personIds: ['person-01', 'person-02'], companyId: 'co-01' } });
    const input = (write as { input: { title: string; bodyMarkdown: string } }).input;
    expect(input.title).toBe('[Cadence] Meeting: Pricing walk-through');
    expect(input.bodyMarkdown).toContain('Booked by: Karson');
    expect(input.bodyMarkdown).toContain('Products: PHH');
    expect(input.bodyMarkdown).toContain('(30 min)');
    expect(input.bodyMarkdown).toContain('https://www.loom.com/share/abc123');
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).twentyNoteId).toBe(id);
    // Reading Twenty back never takes Cadence's own note for an email or a call.
    expect(classifyNoteTitle(input.title, (await getSettings()).matching).kind).toBe('cadence');
  });

  it('replaces the note when the meeting changes, and removes it when the meeting goes', async () => {
    const m = await meeting();
    const first = await syncMeetingToCrm(m.id);
    await prisma.meeting.update({ where: { id: m.id }, data: { title: 'Pricing, second call' } });
    const second = await syncMeetingToCrm(m.id);
    expect(second).not.toBe(first);
    expect(mock.writes).toContainEqual({ op: 'deleteNote', id: first });
    await removeMeetingFromCrm(second);
    expect(mock.writes.at(-1)).toEqual({ op: 'deleteNote', id: second });
  });

  it('leaves a meeting with no contact and no account until it has one', async () => {
    const m = await prisma.meeting.create({ data: { title: 'Internal', sourceUrl: '', occurredAt: new Date(), bookedById: b.users.karson.id } });
    expect(await syncMeetingToCrm(m.id)).toBeNull();
    expect(mock.writes.filter((w) => w.op === 'createNote')).toHaveLength(0);
  });

  it('says when, how long and who, in plain words', () => {
    const note = meetingNote({ id: 'm1', title: 'Intro', sourceUrl: '', occurredAt: new Date('2027-03-04T16:00:00Z'), durationSec: null, products: [], companyId: null, companyName: null, bookedBy: null, attendees: [] }, '[Cadence]');
    expect(note.title).toBe('[Cadence] Meeting: Intro');
    expect(note.bodyMarkdown).toMatch(/When: Thu, Mar 4, 2027/);
    expect(note.bodyMarkdown).not.toContain('Recording');
  });
});
