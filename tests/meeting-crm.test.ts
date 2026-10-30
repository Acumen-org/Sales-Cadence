import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { backfillMeetingsToCrm, meetingNote, meetingSchemaShape, removeMeetingFromCrm, syncMeetingToCrm, transcriptText } from '@/lib/meetings/crm';
import { renumberProspects } from '@/lib/meetings/numbering';
import { classifyNoteTitle } from '@/lib/engine/matching';
import { getSettings } from '@/lib/settings';

/**
 * Twenty keeps the record: a meeting added in Cadence is a record in the workspace's own Meetings
 * object, with its contacts linked through Meeting contacts, updated when the meeting changes and
 * removed when it is deleted. A workspace without that object gets a note instead.
 */
describe('meetings recorded in Twenty', () => {
  let b: Basics;
  const mock = getMockTwentyClient();

  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    mock.reset();
    mock.writes = [];
  });

  const meeting = () => prisma.meeting.create({ data: {
    title: 'Pricing walk-through', sourceUrl: 'https://www.loom.com/share/abc123', occurredAt: new Date('2027-03-04T16:00:00Z'), durationSec: 1800,
    bookedById: b.users.karson.id, products: ['PHH', 'GLYNAC'], companyId: 'co-01', companyName: 'Acme',
    attendees: { create: [
      { personId: 'person-01', email: 'p1@prospect.example', name: 'Pat One', external: true, prospect: true },
      { personId: 'person-02', email: 'p2@prospect.example', name: 'Pam Two', external: true, prospect: true },
      { userId: b.users.karson.id, email: b.users.karson.email, name: b.users.karson.name, external: false },
      { userId: b.users.alisa.id, email: b.users.alisa.email, name: b.users.alisa.name, external: false },
      { name: 'Guest Without Record', external: true },
    ] },
  } });

  it('writes one Meetings record with tags, the account, a link back and every contact', async () => {
    const m = await meeting();
    const id = await syncMeetingToCrm(m.id);
    expect(id).toBeTruthy();
    const record = mock.meetingRecords.get(id!)!;
    expect(record.cadenceId).toBe(m.id);
    expect(record.data).toMatchObject({
      name: 'Pricing walk-through',
      // The team made Meeting Date a date field, so it holds the day in Central time.
      meetingDate: '2027-03-04',
      products: ['PHH', 'GLYNAC'],
      companiesId: 'co-01',
      peopleId: 'person-01',
      cadenceId: m.id,
      guestsOptional: 'Guest Without Record',
      recording: { primaryLinkUrl: 'https://www.loom.com/share/abc123' },
    });
    // Who booked it and who from the team was on it are tags; a missing tag is added.
    const tag = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    expect(record.data.bookedBy).toBe(tag(b.users.karson.name));
    expect(record.data.teamOnTheCall).toEqual(expect.arrayContaining([tag(b.users.karson.name), tag(b.users.alisa.name)]));
    expect(mock.writes.filter((w) => w.op === 'addSelectOption').map((w) => (w as { label: string }).label)).toEqual(expect.arrayContaining([b.users.karson.name, b.users.alisa.name]));
    expect(record.contacts.map((c) => c.personId)).toEqual(['person-01', 'person-02']);
    // Each Meeting contact is named for the meeting and the person, so both sides read well in Twenty.
    const people = await prisma.personCache.findMany({ where: { id: { in: ['person-01', 'person-02'] } }, orderBy: { id: 'asc' } });
    expect(record.contacts.map((c) => c.name)).toEqual(people.map((p) => `Pricing walk-through · ${p.firstName} ${p.lastName}`.trim()));
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).twentyMeetingId).toBe(id);
    // No note is written once the workspace has a Meetings object.
    expect(mock.writes.some((w) => w.op === 'createNote')).toBe(false);
  });

  it('keeps a team member who is also a person in the CRM on the team, not among the contacts', async () => {
    const m = await meeting();
    // Like Alisa: on the team in Cadence, and a People record in Twenty, added by that record.
    await prisma.meetingAttendee.create({ data: { meetingId: m.id, personId: 'person-03', email: b.users.leigh.email, name: b.users.leigh.name, external: false } });
    const id = await syncMeetingToCrm(m.id);
    const record = mock.meetingRecords.get(id!)!;
    expect(record.contacts.map((c) => c.personId)).toEqual(['person-01', 'person-02']);
    const tag = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    expect(record.data.teamOnTheCall).toEqual(expect.arrayContaining([tag(b.users.leigh.name)]));
    // The meeting's single People link is its first contact, never someone from the team.
    expect(record.data.peopleId).toBe('person-01');
  });

  it('updates the same record when the meeting changes, and removes it when the meeting goes', async () => {
    const m = await meeting();
    const first = await syncMeetingToCrm(m.id);
    await prisma.meeting.update({ where: { id: m.id }, data: { title: 'Pricing, second call' } });
    await prisma.meetingAttendee.deleteMany({ where: { meetingId: m.id, personId: 'person-02' } });
    const second = await syncMeetingToCrm(m.id);
    expect(second).toBe(first);
    expect(mock.meetingRecords.get(first!)!.data.name).toBe('Pricing, second call');
    expect(mock.meetingRecords.get(first!)!.contacts.map((c) => c.personId)).toEqual(['person-01']);
    await removeMeetingFromCrm({ twentyMeetingId: first, twentyNoteId: null });
    expect(mock.meetingRecords.has(first!)).toBe(false);
  });

  it('writes the meetings already in Cadence once the Meetings object exists', async () => {
    mock.meetingObject = null;
    const m = await meeting();
    expect(await backfillMeetingsToCrm()).toBeNull();
    mock.meetingObject = (await import('@/lib/twenty/mock-client')).MOCK_MEETING_SCHEMA();
    expect(await backfillMeetingsToCrm()).toBe(1);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).twentyMeetingId).toBeTruthy();
    expect(await backfillMeetingsToCrm()).toBe(0);
  });

  it("carries each prospect's count on their Meeting contact row, and the meeting's own on the record", async () => {
    // Pat met us once before; Pam is new. The meeting is the higher of the two: a 2nd, not a first.
    const earlier = await prisma.meeting.create({ data: { title: 'Intro', sourceUrl: '', occurredAt: new Date('2027-02-01T18:00:00Z'), bookedById: b.users.karson.id, products: ['PHH'], attendees: { create: [{ personId: 'person-01', email: 'p1@prospect.example', name: 'Pat One', external: true, prospect: true }] } } });
    const m = await meeting();
    await prisma.meeting.update({ where: { id: m.id }, data: { transcript: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Pat One>Shall we start?\n', transcriptFormat: 'vtt' } });
    await renumberProspects(['person-01', 'person-02']);
    const id = await syncMeetingToCrm(m.id);
    const record = mock.meetingRecords.get(id!)!;
    expect(record.data).toMatchObject({ meetingNumber: 2, firstMeeting: false, transcript: 'Pat One: Shall we start?' });
    const row = (personId: string) => record.contacts.find((c) => c.personId === personId)!.data!;
    const tag = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    expect(row('person-01')).toMatchObject({ meetingNumber: 2, firstMeeting: false, meetingDate: '2027-03-04', bookedBy: tag(b.users.karson.name), products: ['PHH', 'GLYNAC'] });
    expect(row('person-02')).toMatchObject({ meetingNumber: 1, firstMeeting: true, meetingDate: '2027-03-04' });
    expect(row('person-02').teamOnTheCall).toEqual(expect.arrayContaining([tag(b.users.karson.name), tag(b.users.alisa.name)]));
    // The earlier meeting with Pat alone was a first meeting.
    const intro = mock.meetingRecords.get((await syncMeetingToCrm(earlier.id))!)!;
    expect(intro.data).toMatchObject({ meetingNumber: 1, firstMeeting: true });
  });

  it('writes the names out when the workspace made a field plain text, and caps a long transcript', async () => {
    const schema = (await import('@/lib/twenty/mock-client')).MOCK_MEETING_SCHEMA();
    schema.contact!.fields.bookedBy = { id: 'text-booked', name: 'bookedBy', text: true, options: [] };
    mock.meetingObject = schema;
    const m = await meeting();
    await renumberProspects(['person-01', 'person-02']);
    const record = mock.meetingRecords.get((await syncMeetingToCrm(m.id))!)!;
    expect(record.contacts[0].data!.bookedBy).toBe(b.users.karson.name);
    expect(transcriptText('x'.repeat(150_000)).length).toBeLessThan(100_100);
    expect(transcriptText('x'.repeat(150_000))).toMatch(/full transcript is in Cadence\]$/);
  });

  it('notices when the admin adds a field, so every meeting is written again', () => {
    const schema = (async () => (await import('@/lib/twenty/mock-client')).MOCK_MEETING_SCHEMA())();
    return schema.then((s) => {
      const before = meetingSchemaShape({ ...s, fields: { ...s.fields, meetingNumber: null } });
      expect(meetingSchemaShape(s)).not.toBe(before);
      expect(meetingSchemaShape(s)).toBe(meetingSchemaShape(JSON.parse(JSON.stringify(s))));
    });
  });

  it('falls back to a note on the contacts and account without a Meetings object', async () => {
    mock.meetingObject = null;
    const m = await meeting();
    const id = await syncMeetingToCrm(m.id);
    const write = mock.writes.find((w) => w.op === 'createNote') as { input: { title: string; bodyMarkdown: string; personIds: string[]; companyId: string } };
    expect(write.input).toMatchObject({ personIds: ['person-01', 'person-02'], companyId: 'co-01' });
    expect(write.input.title).toBe('[Cadence] Meeting: Pricing walk-through');
    expect(write.input.bodyMarkdown).toContain('Booked by: Karson');
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).twentyNoteId).toBe(id);
    // Reading Twenty back never takes Cadence's own note for an email or a call.
    expect(classifyNoteTitle(write.input.title, (await getSettings()).matching).kind).toBe('cadence');
  });

  it('says when and who in plain words', () => {
    const note = meetingNote({ id: 'm1', title: 'Intro', sourceUrl: '', occurredAt: new Date('2027-03-04T16:00:00Z'), products: [], companyId: null, companyName: null, bookedBy: null, attendees: [] }, '[Cadence]');
    expect(note.title).toBe('[Cadence] Meeting: Intro');
    expect(note.bodyMarkdown).toMatch(/When: Thu, Mar 4, 2027/);
    expect(note.bodyMarkdown).not.toContain('Recording');
  });
});

describe('a meeting has a day, not a time', () => {
  it('keeps the date the form sends, and reads the same day back', async () => {
    const { meetingDay, meetingDayInstant, parseMeetingDay } = await import('@/lib/meetings/day');
    expect(parseMeetingDay('2026-10-09')).toBe('2026-10-09');
    // A form from before the change still sends a time; the date is kept.
    expect(parseMeetingDay('2026-10-09T22:30')).toBe('2026-10-09');
    expect(parseMeetingDay('2026-02-30')).toBeNull();
    expect(meetingDay(meetingDayInstant('2026-10-09'))).toBe('2026-10-09');
    // A meeting saved late in the evening before the change stays on its own day.
    expect(meetingDay(new Date('2026-10-10T03:30:00Z'))).toBe('2026-10-09');
  });
});
