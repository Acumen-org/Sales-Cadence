import type { TwentyCompany, TwentyMessage, TwentyNote, TwentyOpportunity, TwentyPerson, TwentyTask, TwentyView, TwentyWorkspaceMember } from './types';

/**
 * The demo workspace used by the app in mock mode: one dummy record of everything.
 * Two real pods (Alisa, Andrew), one person whose podOwner ("Karson") has no pod yet so the
 * pod-discovery path can be seen working, one dnd person, one company with three colleagues.
 * Everything is named "Dummy ..." so nobody mistakes it for real data.
 */

export const DEMO_MEMBERS: TwentyWorkspaceMember[] = [
  { id: 'wm-ria', firstName: 'Ria', lastName: 'Admin', email: 'ria@dummy.example', timeZone: 'Europe/London' },
  { id: 'wm-alisa', firstName: 'Alisa', lastName: 'Senior', email: 'alisa@dummy.example', timeZone: 'Europe/London' },
  { id: 'wm-andrew', firstName: 'Andrew', lastName: 'Senior', email: 'andrew@dummy.example', timeZone: 'Europe/London' },
  { id: 'wm-karson', firstName: 'Karson', lastName: 'Junior', email: 'karson@dummy.example', timeZone: 'Europe/London' },
  { id: 'wm-daniel', firstName: 'Daniel', lastName: 'Junior', email: 'daniel@dummy.example', timeZone: 'Europe/London' },
];

/**
 * podOwner select options as Twenty would report them (value + label). "Karson" is deliberately
 * absent even though Dummy Twelve carries it, so the pod-discovery path is visible in the demo.
 */
export const DEMO_POD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'Alisa', label: "Alisa's pod" },
  { value: 'Andrew', label: "Andrew's pod" },
];

/** Account owner is a Twenty workspace member, so "accounts I own" works per signed-in user. */
export const DEMO_COMPANIES: TwentyCompany[] = [
  {
    id: 'dummy-co-a',
    name: 'Dummy Company A',
    domain: 'dummy-a.example',
    ownerMemberId: 'wm-alisa',
    industry: 'Asset management',
    employees: 420,
    city: 'London',
    linkedinUrl: 'https://www.linkedin.com/company/dummy-company-a',
    updatedAt: '2026-08-15T09:00:00.000Z',
  },
  {
    id: 'dummy-co-b',
    name: 'Dummy Company B',
    domain: 'dummy-b.example',
    ownerMemberId: 'wm-karson',
    industry: 'Insurance',
    employees: 1800,
    city: 'Manchester',
    linkedinUrl: 'https://www.linkedin.com/company/dummy-company-b',
    updatedAt: '2026-08-15T09:00:00.000Z',
  },
  {
    id: 'dummy-co-c',
    name: 'Dummy Company C',
    domain: 'dummy-c.example',
    ownerMemberId: 'wm-andrew',
    industry: 'Private equity',
    employees: 95,
    city: 'Berlin',
    linkedinUrl: 'https://www.linkedin.com/company/dummy-company-c',
    updatedAt: '2026-08-15T09:00:00.000Z',
  },
];

// [lastName, companyId, jobTitle, podOwner, ownerMemberId, eventSource, dnd]
type Row = [string, string, string, string, string | null, string, boolean?];
const rows: Row[] = [
  ['One', 'dummy-co-a', 'VP Operations', 'Alisa', 'wm-alisa', 'Dummy Conference 2026'],
  ['Two', 'dummy-co-a', 'Head of Sales', 'Alisa', 'wm-alisa', 'Dummy Conference 2026'],
  ['Three', 'dummy-co-a', 'CTO', 'Alisa', 'wm-karson', 'Referral'],
  ['Four', 'dummy-co-b', 'CEO', 'Alisa', 'wm-karson', 'Webinar'],
  ['Five', 'dummy-co-b', 'CFO', 'Alisa', null, 'LinkedIn'],
  ['Six', 'dummy-co-b', 'COO', 'Alisa', 'wm-alisa', 'Webinar', true],
  ['Seven', 'dummy-co-c', 'Head of Growth', 'Andrew', 'wm-andrew', 'Dummy Conference 2026'],
  ['Eight', 'dummy-co-c', 'Director of Marketing', 'Andrew', 'wm-andrew', 'Referral'],
  ['Nine', 'dummy-co-c', 'Head of Partnerships', 'Andrew', 'wm-daniel', 'LinkedIn'],
  ['Ten', 'dummy-co-a', 'Procurement Lead', 'Andrew', 'wm-daniel', 'Webinar'],
  ['Eleven', 'dummy-co-b', 'VP Product', 'Andrew', null, 'Referral'],
  ['Twelve', 'dummy-co-c', 'Head of Data', 'Karson', 'wm-karson', 'LinkedIn'],
  // Used by the "starting today" campaigns so every pod has work due today.
  ['Thirteen', 'dummy-co-a', 'Head of Finance', 'Alisa', 'wm-alisa', 'Dummy Conference 2026'],
  ['Fourteen', 'dummy-co-b', 'Head of People', 'Alisa', 'wm-karson', 'Webinar'],
  ['Fifteen', 'dummy-co-c', 'VP Engineering', 'Andrew', 'wm-andrew', 'Referral'],
  ['Sixteen', 'dummy-co-a', 'Head of Support', 'Andrew', 'wm-daniel', 'LinkedIn'],
];

export const DEMO_PEOPLE: TwentyPerson[] = rows.map((r, i) => {
  const [lastName, companyId, jobTitle, podOwner, ownerMemberId, eventSource, dnd] = r;
  const company = DEMO_COMPANIES.find((c) => c.id === companyId)!;
  const n = i + 1;
  return {
    id: `dummy-${String(n).padStart(2, '0')}`,
    firstName: 'Dummy',
    lastName,
    email: `dummy.${lastName.toLowerCase()}@${company.domain}`,
    phone: `+44 20 7000 ${String(1000 + n).padStart(4, '0')}`,
    linkedinUrl: `https://www.linkedin.com/in/dummy-${lastName.toLowerCase()}`,
    jobTitle,
    city: ['London', 'Manchester', 'Berlin'][i % 3],
    companyId: company.id,
    companyName: company.name,
    dnd: Boolean(dnd),
    podOwner,
    ownerMemberId,
    tags: i % 2 ? ['dummy', 'warm'] : ['dummy'],
    eventSource,
    statusOfMeeting: null,
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    deletedAt: null,
  };
});

export const DEMO_NOTES: TwentyNote[] = [
  {
    id: 'dummy-note-01',
    title: '[Email] Outbound email: Intro to Dummy Company A',
    bodyMarkdown: 'Dummy outbound email note, as Twenty writes it.',
    createdByMemberId: 'wm-alisa',
    createdByName: 'Alisa Senior',
    createdBySource: 'MANUAL',
    personIds: ['dummy-01'],
    companyIds: [],
    createdAt: '2026-09-01T09:15:00.000Z',
    updatedAt: '2026-09-01T09:15:00.000Z',
  },
  {
    id: 'dummy-note-02',
    title: '[CALL] Outbound Call by tw_alisa',
    bodyMarkdown: 'Dummy call note from a telephony tool.',
    createdByMemberId: null,
    createdByName: null,
    createdBySource: 'API',
    personIds: ['dummy-04'],
    companyIds: [],
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
  },
  {
    id: 'dummy-note-03',
    title: 'Call Notes [02-Sep-2026]',
    bodyMarkdown: 'Dummy free-form call notes.',
    createdByMemberId: 'wm-andrew',
    createdByName: 'Andrew Senior',
    createdBySource: 'MANUAL',
    personIds: ['dummy-07'],
    companyIds: [],
    createdAt: '2026-09-02T15:30:00.000Z',
    updatedAt: '2026-09-02T15:30:00.000Z',
  },
  {
    id: 'dummy-note-04',
    title: 'Meeting prep: Dummy Company C',
    bodyMarkdown: 'A plain note that is not evidence of anything.',
    createdByMemberId: 'wm-andrew',
    createdByName: 'Andrew Senior',
    createdBySource: 'MANUAL',
    personIds: ['dummy-08'],
    companyIds: ['dummy-co-c'],
    createdAt: '2026-09-03T16:00:00.000Z',
    updatedAt: '2026-09-03T16:00:00.000Z',
  },
];

const p = (messageId: string, n: number, role: 'from' | 'to' | 'cc', handle: string, personId: string | null, workspaceMemberId: string | null) => ({
  id: `${messageId}-p${n}`,
  messageId,
  role,
  handle,
  displayName: null,
  personId,
  workspaceMemberId,
});

export const DEMO_MESSAGES: TwentyMessage[] = [
  {
    id: 'dummy-msg-01',
    subject: 'Dummy Company A <> a quick idea',
    text: 'Dummy outbound email synced from the mailbox.',
    receivedAt: '2026-09-01T09:14:00.000Z',
    threadId: 'dummy-thread-01',
    updatedAt: '2026-09-01T09:14:30.000Z',
    participants: [p('dummy-msg-01', 1, 'from', 'alisa@dummy.example', null, 'wm-alisa'), p('dummy-msg-01', 2, 'to', 'dummy.one@dummy-a.example', 'dummy-01', null)],
  },
  {
    id: 'dummy-msg-02',
    subject: 'Re: Dummy Company A <> a quick idea',
    text: 'Thanks, happy to talk next week.',
    receivedAt: '2026-09-03T11:00:00.000Z',
    threadId: 'dummy-thread-02',
    updatedAt: '2026-09-03T11:00:30.000Z',
    participants: [p('dummy-msg-02', 1, 'from', 'dummy.two@dummy-a.example', 'dummy-02', null), p('dummy-msg-02', 2, 'to', 'alisa@dummy.example', null, 'wm-alisa')],
  },
];

export const DEMO_OPPORTUNITIES: TwentyOpportunity[] = [
  {
    id: 'dummy-opp-01',
    name: 'Dummy Company C - pilot',
    stage: 'MEETING',
    pointOfContactId: 'dummy-08',
    companyId: 'dummy-co-c',
    createdAt: '2026-09-04T13:00:00.000Z',
    updatedAt: '2026-09-04T13:00:00.000Z',
  },
];

export const DEMO_TASKS: TwentyTask[] = [];

export const DEMO_VIEWS: TwentyView[] = [
  { id: 'view-alisa-pod', name: "Alisa's pod - all people", objectSingular: 'person', personIds: DEMO_PEOPLE.filter((x) => x.podOwner === 'Alisa').map((x) => x.id) },
  { id: 'view-andrew-pod', name: "Andrew's pod - all people", objectSingular: 'person', personIds: DEMO_PEOPLE.filter((x) => x.podOwner === 'Andrew').map((x) => x.id) },
  { id: 'view-all-dummies', name: 'All dummy people', objectSingular: 'person', personIds: DEMO_PEOPLE.map((x) => x.id) },
];
