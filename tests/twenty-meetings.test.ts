import { describe, expect, it } from 'vitest';
import { TwentyGraphqlClient } from '@/lib/twenty/graphql-client';
import { mergeTwentySchema } from '@/lib/twenty/twenty-schema';

type Call = { url: string; query: string; variables: Record<string, unknown> };

/**
 * The Meetings and Meeting Contacts objects as the team created them in Twenty (October 2026,
 * from their screenshots): Meeting Date is a date, the company link is called Companies, the
 * person link People, Guests is labelled "Guests (optional)", plus a deactivated Transcription link.
 */
const field = (name: string, label: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f-${name}`, name, label, type, isCustom: true, ...extra });
const system = (name: string, label: string, type: string) => ({ id: `f-${name}`, name, label, type, isCustom: false });
const METADATA = {
  objects: {
    edges: [
      { node: { id: 'o-meeting', nameSingular: 'meeting', namePlural: 'meetings', isCustom: true, fieldsList: [
        system('createdAt', 'Creation date', 'DATE_TIME'),
        system('updatedAt', 'Last update', 'DATE_TIME'),
        system('name', 'Name', 'TEXT'),
        field('bookedBy', 'Booked By', 'SELECT', { options: [{ id: 'o1', value: 'ALISA_KOLODIZNER', label: 'Alisa Kolodizner', color: 'blue', position: 0 }] }),
        field('cadenceId', 'Cadence ID', 'TEXT'),
        field('guestsOptional', 'Guests (optional)', 'TEXT'),
        field('inCadence', 'In Cadence', 'LINKS'),
        field('meetingDate', 'Meeting Date', 'DATE'),
        field('products', 'Products', 'MULTI_SELECT', { options: [{ id: 'p1', value: 'PHH', label: 'PHH' }, { id: 'p2', value: 'ACUBOOTH', label: 'Acubooth' }, { id: 'p3', value: 'GLYNAC', label: 'Glynac' }] }),
        field('recording', 'Recording', 'LINKS'),
        field('teamOnTheCall', 'Team on the call', 'MULTI_SELECT', { options: [] }),
        field('transcription', 'Transcription', 'LINKS'),
        // Added for the meeting counts (29 October 2026).
        field('meetingNumber', 'Meeting Number', 'NUMBER'),
        field('firstMeeting', 'First Meeting', 'BOOLEAN'),
        field('companies', 'Companies', 'RELATION'),
        field('people', 'People', 'RELATION'),
        field('assignedTo', 'Assigned to', 'RELATION'),
        field('meetingContacts', 'Meeting Contacts', 'RELATION'),
      ] } },
      { node: { id: 'o-mc', nameSingular: 'meetingContact', namePlural: 'meetingContacts', isCustom: true, fieldsList: [system('name', 'Name', 'TEXT'), field('meetings', 'Meetings', 'RELATION'), field('people', 'People', 'RELATION')] } },
      { node: { id: 'o-person', nameSingular: 'person', namePlural: 'people', isCustom: false, fieldsList: [system('name', 'Name', 'FULL_NAME')] } },
    ],
  },
};
const obj = (name: string) => ({ kind: 'OBJECT', name, ofType: null });
const scalar = (name: string) => ({ kind: 'SCALAR', name, ofType: null });
const TYPES: Record<string, Array<{ name: string; type: unknown }>> = {
  Meeting: [
    { name: 'id', type: scalar('UUID') }, { name: 'name', type: scalar('String') }, { name: 'createdBy', type: obj('Actor') },
    { name: 'companies', type: obj('Company') }, { name: 'companiesId', type: scalar('UUID') },
    { name: 'people', type: obj('Person') }, { name: 'peopleId', type: scalar('UUID') },
    { name: 'assignedTo', type: obj('WorkspaceMember') }, { name: 'assignedToId', type: scalar('UUID') },
    { name: 'meetingContacts', type: obj('MeetingContactConnection') },
  ],
  MeetingContact: [
    { name: 'id', type: scalar('UUID') }, { name: 'name', type: scalar('String') },
    { name: 'meetings', type: obj('Meeting') }, { name: 'meetingsId', type: scalar('UUID') },
    { name: 'people', type: obj('Person') }, { name: 'peopleId', type: scalar('UUID') },
  ],
};

function fakeTwenty() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const call = { url: String(url), query: body.query, variables: body.variables ?? {} };
    calls.push(call);
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (call.url.endsWith('/metadata') && call.query.includes('objects')) return reply(METADATA);
    if (call.url.endsWith('/metadata') && call.query.includes('updateOneField')) return reply({ updateOneField: { id: 'f-teamOnTheCall' } });
    if (call.query.includes('__type')) return reply({ __type: { fields: TYPES[String(call.variables.name)] ?? [] } });
    if (call.query.includes('FindMeeting')) return reply({ meetings: { edges: [] } });
    if (call.query.includes('createMeeting(')) return reply({ createMeeting: { id: 'rec-1' } });
    if (call.query.includes('MeetingContacts')) return reply({ meetingContacts: { edges: [] } });
    if (call.query.includes('createMeetingContact(')) return reply({ createMeetingContact: { id: `mc-${calls.length}` } });
    return reply({});
  }) as typeof fetch;
  const client = new TwentyGraphqlClient({ baseUrl: 'https://twenty.example.com/', apiKey: 'k', schema: mergeTwentySchema(), fetchImpl });
  return { client, calls };
}

describe('the Meetings object the team made in Twenty', () => {
  it('finds every field by what it is, whatever Twenty named it', async () => {
    const { client } = fakeTwenty();
    const schema = await client.meetingSchema();
    expect(schema).not.toBeNull();
    expect(schema!.meeting).toEqual({ typeName: 'Meeting', plural: 'meetings' });
    expect(schema!.fields).toMatchObject({
      // The meeting's own date, not the record's creation date.
      date: { name: 'meetingDate', dateOnly: true },
      bookedBy: { name: 'bookedBy', multi: false },
      products: { name: 'products', multi: true },
      team: { name: 'teamOnTheCall', multi: true },
      recording: 'recording',
      cadenceLink: 'inCadence',
      cadenceId: 'cadenceId',
      guests: 'guestsOptional',
      companyId: 'companiesId',
      personId: 'peopleId',
      assigneeId: 'assignedToId',
      meetingNumber: 'meetingNumber',
      firstMeeting: 'firstMeeting',
    });
    expect(schema!.contact).toEqual({ typeName: 'MeetingContact', plural: 'meetingContacts', meetingId: 'meetingsId', personId: 'peopleId' });
  });

  it('creates the record with its values and one Meeting contact per contact', async () => {
    const { client, calls } = fakeTwenty();
    const schema = (await client.meetingSchema())!;
    const { id } = await client.saveMeetingRecord(schema, { id: null, cadenceId: 'm-1', data: { name: 'Intro', meetingDate: '2026-10-09', companiesId: 'c-1' }, contacts: [{ personId: 'p-1', name: 'Nina Halvorsen' }, { personId: 'p-2', name: 'Tomas Berg' }] });
    expect(id).toBe('rec-1');
    // Looked for an earlier record with the same Cadence ID before creating one.
    expect(calls.find((c) => c.query.includes('FindMeeting'))!.variables).toEqual({ filter: { cadenceId: { eq: 'm-1' } } });
    expect(calls.find((c) => c.query.includes('createMeeting('))!.variables).toEqual({ data: { name: 'Intro', meetingDate: '2026-10-09', companiesId: 'c-1' } });
    const links = calls.filter((c) => c.query.includes('createMeetingContact(')).map((c) => c.variables.data);
    expect(links).toEqual([{ name: 'Nina Halvorsen', meetingsId: 'rec-1', peopleId: 'p-1' }, { name: 'Tomas Berg', meetingsId: 'rec-1', peopleId: 'p-2' }]);
  });

  it('adds a missing tag through the data model, keeping the ones already there', async () => {
    const { client, calls } = fakeTwenty();
    const schema = (await client.meetingSchema())!;
    expect(await client.addSelectOption(schema.fields.bookedBy!, 'Alyssa Grant')).toBe('ALYSSA_GRANT');
    const update = calls.find((c) => c.query.includes('updateOneField'))!;
    const options = (update.variables.input as { update: { options: Array<{ value: string }> } }).update.options;
    expect(options.map((o) => o.value)).toEqual(['ALISA_KOLODIZNER', 'ALYSSA_GRANT']);
  });

  it('says there is no Meetings object when the workspace has none', async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), query: JSON.parse(String(init?.body)).query, variables: {} });
      return new Response(JSON.stringify({ data: { objects: { edges: [] } } }), { status: 200 });
    }) as typeof fetch;
    const client = new TwentyGraphqlClient({ baseUrl: 'https://twenty.example.com/', apiKey: 'k', schema: mergeTwentySchema(), fetchImpl });
    expect(await client.meetingSchema()).toBeNull();
  });
});
