import type {
  TwentyCompany,
  TwentyMessage,
  TwentyNote,
  TwentyOpportunity,
  TwentyPerson,
  TwentyTask,
  TwentyView,
  TwentyWorkspaceMember,
} from './types';

/**
 * Deterministic fixtures for the mock Twenty workspace:
 * 3 pods (Alisa, Leigh, Andrew), 6 workspace members, 14 companies, 40 people,
 * and activity in the exact note title formats Twenty produces.
 */

export const MOCK_MEMBERS: TwentyWorkspaceMember[] = [
  { id: 'wm-alisa', firstName: 'Alisa', lastName: 'Marsh', email: 'alisa@acumen.example', timeZone: 'Europe/London' },
  { id: 'wm-leigh', firstName: 'Leigh', lastName: 'Turner', email: 'leigh@acumen.example', timeZone: 'Europe/London' },
  { id: 'wm-andrew', firstName: 'Andrew', lastName: 'Cole', email: 'andrew@acumen.example', timeZone: 'Europe/London' },
  { id: 'wm-karson', firstName: 'Karson', lastName: 'Reed', email: 'karson@acumen.example', timeZone: 'Europe/London' },
  { id: 'wm-daniel', firstName: 'Daniel', lastName: 'Okafor', email: 'daniel@acumen.example', timeZone: 'Europe/London' },
  { id: 'wm-ria', firstName: 'Ria', lastName: 'Patel', email: 'ria@acumen.example', timeZone: 'Europe/London' },
];

export const MOCK_PODS = ['Alisa', 'Leigh', 'Andrew'] as const;

const companyNames = [
  'Acme Logistics',
  'Bluefin Capital',
  'Corvid Analytics',
  'Delta Freight',
  'Everly Health',
  'Fjord Robotics',
  'Granite Insurance',
  'Harbor Media',
  'Ionic Energy',
  'Juniper Retail',
  'Kestrel Aerospace',
  'Lumen Biotech',
  'Meridian Bank',
  'Northwind Traders',
];

export const MOCK_COMPANIES: TwentyCompany[] = companyNames.map((name, i) => ({
  id: `co-${String(i + 1).padStart(2, '0')}`,
  name,
  domain: `${name.toLowerCase().replace(/[^a-z]/g, '')}.example`,
  updatedAt: '2026-08-15T09:00:00.000Z',
}));

// [first, last, companyIndex(1-based), jobTitle, podOwner, ownerMemberId, eventSource, dnd]
type PersonRow = [string, string, number, string, string, string | null, string, boolean?];

const rows: PersonRow[] = [
  // Pod Alisa (14)
  ['Nina', 'Halvorsen', 1, 'VP Operations', 'Alisa', 'wm-alisa', 'SaaStr 2026'],
  ['Tomas', 'Berg', 1, 'Head of Logistics', 'Alisa', 'wm-alisa', 'SaaStr 2026'],
  ['Priya', 'Nair', 2, 'Partner', 'Alisa', 'wm-alisa', 'Referral'],
  ['Marcus', 'Whitfield', 2, 'Investment Director', 'Alisa', 'wm-karson', 'Referral'],
  ['Elena', 'Rossi', 3, 'Chief Data Officer', 'Alisa', 'wm-alisa', 'Web Summit'],
  ['Jonah', 'Adeyemi', 3, 'Head of Growth', 'Alisa', 'wm-karson', 'Web Summit'],
  ['Sofia', 'Lindqvist', 4, 'COO', 'Alisa', 'wm-alisa', 'Inbound webinar', true],
  ['Ravi', 'Menon', 4, 'Director of Sales', 'Alisa', 'wm-karson', 'Inbound webinar'],
  ['Hannah', 'Obi', 5, 'VP Marketing', 'Alisa', 'wm-alisa', 'LinkedIn'],
  ['Lukas', 'Meyer', 5, 'Head of Partnerships', 'Alisa', null, 'LinkedIn'],
  ['Grace', 'Kimura', 6, 'CEO', 'Alisa', 'wm-alisa', 'SaaStr 2026'],
  ['Oscar', 'Delgado', 6, 'CTO', 'Alisa', 'wm-karson', 'SaaStr 2026'],
  ['Maya', 'Fischer', 7, 'Head of Claims', 'Alisa', 'wm-alisa', 'Referral'],
  ['Ethan', 'Brooks', 7, 'Chief Revenue Officer', 'Alisa', 'wm-alisa', 'Referral'],
  // Pod Leigh (13)
  ['Isabel', 'Moreau', 8, 'Managing Director', 'Leigh', 'wm-leigh', 'Web Summit'],
  ['Kwame', 'Mensah', 8, 'Head of Sales', 'Leigh', 'wm-leigh', 'Web Summit'],
  ['Freya', 'Jensen', 9, 'VP Commercial', 'Leigh', 'wm-daniel', 'Inbound webinar'],
  ['Diego', 'Alvarez', 9, 'Director of Operations', 'Leigh', 'wm-leigh', 'Inbound webinar'],
  ['Chloe', 'Bennett', 10, 'Chief Marketing Officer', 'Leigh', 'wm-leigh', 'LinkedIn', true],
  ['Samir', 'Haddad', 10, 'Head of Digital', 'Leigh', 'wm-daniel', 'LinkedIn'],
  ['Anika', 'Sharma', 11, 'VP Engineering', 'Leigh', 'wm-leigh', 'SaaStr 2026'],
  ['Felix', 'Wagner', 11, 'Head of Procurement', 'Leigh', 'wm-daniel', 'SaaStr 2026'],
  ['Zara', 'Ahmed', 12, 'Chief Scientific Officer', 'Leigh', 'wm-leigh', 'Referral'],
  ['Noah', 'Carter', 12, 'Head of Business Development', 'Leigh', null, 'Referral'],
  ['Lena', 'Novak', 13, 'Head of Retail Banking', 'Leigh', 'wm-leigh', 'Web Summit'],
  ['Adam', 'Kowalski', 13, 'Director of Innovation', 'Leigh', 'wm-daniel', 'Web Summit'],
  ['Yuki', 'Tanaka', 14, 'VP Sales', 'Leigh', 'wm-leigh', 'Inbound webinar'],
  // Pod Andrew (13)
  ['Olivia', 'Grant', 14, 'Head of Trading', 'Andrew', 'wm-andrew', 'Inbound webinar'],
  ['Mateo', 'Silva', 1, 'Regional Manager', 'Andrew', 'wm-andrew', 'LinkedIn'],
  ['Amara', 'Nwosu', 2, 'Associate Partner', 'Andrew', 'wm-andrew', 'SaaStr 2026'],
  ['Henrik', 'Sørensen', 3, 'Head of Analytics', 'Andrew', 'wm-andrew', 'Referral'],
  ['Layla', 'Hussein', 4, 'Director of Fleet', 'Andrew', 'wm-andrew', 'Web Summit'],
  ['Ben', 'Thompson', 5, 'Head of Patient Services', 'Andrew', 'wm-andrew', 'Inbound webinar', true],
  ['Ingrid', 'Olsen', 6, 'VP Product', 'Andrew', 'wm-andrew', 'LinkedIn'],
  ['Carlos', 'Ramírez', 7, 'Head of Underwriting', 'Andrew', 'wm-andrew', 'SaaStr 2026'],
  ['Aisha', 'Bello', 8, 'Head of Content', 'Andrew', 'wm-andrew', 'Referral'],
  ['Viktor', 'Petrov', 9, 'Chief Operating Officer', 'Andrew', 'wm-andrew', 'Web Summit'],
  ['Emma', 'Walsh', 10, 'Head of E-commerce', 'Andrew', null, 'Inbound webinar'],
  ['Kenji', 'Sato', 11, 'Programme Director', 'Andrew', 'wm-andrew', 'LinkedIn'],
  ['Sara', 'Lund', 12, 'VP Research', 'Andrew', 'wm-andrew', 'SaaStr 2026'],
];

const TAG_POOL = ['enterprise', 'mid-market', 'warm', 'event-lead', 'referral'];

export const MOCK_PEOPLE: TwentyPerson[] = rows.map((r, i) => {
  const [firstName, lastName, companyIdx, jobTitle, podOwner, ownerMemberId, eventSource, dnd] = r;
  const company = MOCK_COMPANIES[companyIdx - 1];
  const n = i + 1;
  const id = `person-${String(n).padStart(2, '0')}`;
  const slug = `${firstName}.${lastName}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '');
  return {
    id,
    firstName,
    lastName,
    email: `${slug}@${company.domain}`,
    phone: `+44 20 7946 ${String(1000 + n).padStart(4, '0')}`,
    linkedinUrl: `https://www.linkedin.com/in/${slug.replace('.', '-')}`,
    jobTitle,
    city: ['London', 'Manchester', 'Berlin', 'Amsterdam', 'Dublin'][i % 5],
    companyId: company.id,
    companyName: company.name,
    dnd: Boolean(dnd),
    podOwner,
    ownerMemberId,
    tags: [TAG_POOL[i % TAG_POOL.length], ...(i % 7 === 0 ? ['warm'] : [])].filter((t, idx, arr) => arr.indexOf(t) === idx),
    eventSource,
    statusOfMeeting: null,
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: `2026-08-${String(11 + (i % 15)).padStart(2, '0')}T10:00:00.000Z`,
    deletedAt: null,
  };
});

export const MOCK_NOTES: TwentyNote[] = [
  {
    id: 'note-01',
    title: '[Email] Outbound email: Intro to Acme Logistics',
    bodyMarkdown: 'Sent the intro email after SaaStr.',
    createdByMemberId: 'wm-alisa',
    createdByName: 'Alisa Marsh',
    createdBySource: 'MANUAL',
    personIds: ['person-01'],
    companyIds: [],
    createdAt: '2026-09-01T09:15:00.000Z',
    updatedAt: '2026-09-01T09:15:00.000Z',
  },
  {
    id: 'note-02',
    title: '[CALL] Outbound Call by tw_alisa',
    bodyMarkdown: 'Left a voicemail.',
    createdByMemberId: 'wm-alisa',
    createdByName: 'Alisa Marsh',
    createdBySource: 'API',
    personIds: ['person-02'],
    companyIds: [],
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
  },
  {
    id: 'note-03',
    title: 'Call Notes [31-Aug-2026]',
    bodyMarkdown: 'Spoke briefly, asked to call back next week.',
    createdByMemberId: 'wm-leigh',
    createdByName: 'Leigh Turner',
    createdBySource: 'MANUAL',
    personIds: ['person-15'],
    companyIds: [],
    createdAt: '2026-08-31T15:30:00.000Z',
    updatedAt: '2026-08-31T15:30:00.000Z',
  },
  {
    id: 'note-04',
    title: '[Email] Outbound email: Following up on our conversation',
    bodyMarkdown: 'Sent by Ria, not the FO on this account.',
    createdByMemberId: 'wm-ria',
    createdByName: 'Ria Patel',
    createdBySource: 'MANUAL',
    personIds: ['person-03'],
    companyIds: [],
    createdAt: '2026-09-03T08:45:00.000Z',
    updatedAt: '2026-09-03T08:45:00.000Z',
  },
  {
    id: 'note-05',
    title: 'Meeting prep: Northwind Traders',
    bodyMarkdown: 'Agenda for the discovery call.',
    createdByMemberId: 'wm-andrew',
    createdByName: 'Andrew Cole',
    createdBySource: 'MANUAL',
    personIds: ['person-28'],
    companyIds: ['co-14'],
    createdAt: '2026-09-03T16:00:00.000Z',
    updatedAt: '2026-09-03T16:00:00.000Z',
  },
  {
    id: 'note-06',
    title: '[CALL] Outbound Call by tw_daniel',
    bodyMarkdown: 'No answer.',
    createdByMemberId: 'wm-daniel',
    createdByName: 'Daniel Okafor',
    createdBySource: 'API',
    personIds: ['person-17'],
    companyIds: [],
    createdAt: '2026-09-04T11:20:00.000Z',
    updatedAt: '2026-09-04T11:20:00.000Z',
  },
];

function participant(
  messageId: string,
  n: number,
  role: 'from' | 'to' | 'cc',
  handle: string,
  personId: string | null,
  workspaceMemberId: string | null,
  displayName: string | null = null,
) {
  return { id: `${messageId}-p${n}`, messageId, role, handle, displayName, personId, workspaceMemberId };
}

export const MOCK_MESSAGES: TwentyMessage[] = [
  {
    id: 'msg-01',
    subject: 'Acme Logistics <> a quick idea',
    text: 'Hi Nina, we met at SaaStr...',
    receivedAt: '2026-09-01T09:14:00.000Z',
    threadId: 'thread-01',
    updatedAt: '2026-09-01T09:14:30.000Z',
    participants: [
      participant('msg-01', 1, 'from', 'alisa@acumen.example', null, 'wm-alisa', 'Alisa Marsh'),
      participant('msg-01', 2, 'to', 'nina.halvorsen@acmelogistics.example', 'person-01', null, 'Nina Halvorsen'),
    ],
  },
  {
    id: 'msg-02',
    subject: 'Re: Corvid Analytics <> a quick idea',
    text: 'Thanks Alisa, happy to talk next week.',
    receivedAt: '2026-09-03T11:00:00.000Z',
    threadId: 'thread-02',
    updatedAt: '2026-09-03T11:00:30.000Z',
    participants: [
      participant('msg-02', 1, 'from', 'elena.rossi@corvidanalytics.example', 'person-05', null, 'Elena Rossi'),
      participant('msg-02', 2, 'to', 'alisa@acumen.example', null, 'wm-alisa', 'Alisa Marsh'),
    ],
  },
  {
    id: 'msg-03',
    subject: 'Harbor Media <> a quick idea',
    text: 'Hi Isabel...',
    receivedAt: '2026-09-02T14:05:00.000Z',
    threadId: 'thread-03',
    updatedAt: '2026-09-02T14:05:30.000Z',
    participants: [
      participant('msg-03', 1, 'from', 'leigh@acumen.example', null, 'wm-leigh', 'Leigh Turner'),
      participant('msg-03', 2, 'to', 'isabel.moreau@harbormedia.example', 'person-15', null, 'Isabel Moreau'),
      participant('msg-03', 3, 'cc', 'kwame.mensah@harbormedia.example', 'person-16', null, 'Kwame Mensah'),
    ],
  },
  {
    id: 'msg-04',
    subject: 'Re: Delta Freight',
    text: 'Not interested right now, thanks.',
    receivedAt: '2026-09-04T09:30:00.000Z',
    threadId: 'thread-04',
    updatedAt: '2026-09-04T09:30:30.000Z',
    participants: [
      participant('msg-04', 1, 'from', 'layla.hussein@deltafreight.example', 'person-32', null, 'Layla Hussein'),
      participant('msg-04', 2, 'to', 'andrew@acumen.example', null, 'wm-andrew', 'Andrew Cole'),
    ],
  },
];

export const MOCK_OPPORTUNITIES: TwentyOpportunity[] = [
  {
    id: 'opp-01',
    name: 'Fjord Robotics - outbound pilot',
    stage: 'MEETING',
    pointOfContactId: 'person-11',
    companyId: 'co-06',
    createdAt: '2026-09-04T13:00:00.000Z',
    updatedAt: '2026-09-04T13:00:00.000Z',
  },
];

export const MOCK_TASKS: TwentyTask[] = [];

export const MOCK_VIEWS: TwentyView[] = [
  {
    id: 'view-pod-alisa',
    name: 'Pod Alisa - all people',
    objectSingular: 'person',
    personIds: MOCK_PEOPLE.filter((p) => p.podOwner === 'Alisa').map((p) => p.id),
  },
  {
    id: 'view-saastr-2026',
    name: 'SaaStr 2026 leads',
    objectSingular: 'person',
    personIds: MOCK_PEOPLE.filter((p) => p.eventSource === 'SaaStr 2026').map((p) => p.id),
  },
  {
    id: 'view-pod-leigh',
    name: 'Pod Leigh - all people',
    objectSingular: 'person',
    personIds: MOCK_PEOPLE.filter((p) => p.podOwner === 'Leigh').map((p) => p.id),
  },
];
