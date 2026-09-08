import type { TwentyCompany, TwentyMessage, TwentyNote, TwentyOpportunity, TwentyPerson, TwentyTask, TwentyView, TwentyWorkspaceMember } from './types';

/**
 * The demo workspace used by the app in mock mode: one dummy record of everything.
 * Two real pods (ALISA, ANDREW), one person whose podOwner ("KARSON") has no pod yet so the
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
 * podOwner select options as Twenty reports them: an upper-case value and a human label, which
 * is what becomes the pod's name in Cadence. "KARSON" is deliberately absent even though Dummy
 * Twelve carries it, so the pod-discovery path is visible in the demo.
 */
export const DEMO_POD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'ALISA', label: "Alisa's pod" },
  { value: 'ANDREW', label: "Andrew's pod" },
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

/**
 * One dummy person per shape the real workspace produces, so every field of the person panel
 * has something in it in the demo: each tier, each contact type, each list category, a call
 * recording, a rotated-out record, a do-not-contact select, tags that mean the contact details
 * are missing, and one person whose pod does not exist in Cadence yet.
 */
type Row = {
  last: string;
  co: string;
  title: string;
  pod: string;
  owner: string | null;
  lead: string[];
  tier?: string;
  type?: string[];
  list?: string;
  stage?: string;
  product?: string[];
  campaigns?: string[];
  tags?: string[];
  next?: [action: string, due: string, step: string];
  note?: string;
  lastCall?: string;
  lastEmail?: string;
  recording?: [recording: string, join: string];
  dnd?: boolean;
  calling?: boolean;
  rotatedTo?: string;
};

const rows: Row[] = [
  {
    last: 'One', co: 'dummy-co-a', title: 'VP Operations', pod: 'ALISA', owner: 'wm-alisa',
    lead: ['FPA_WISCONSIN_JULY_2026'], tier: 'LEVEL_1', type: ['PROSPECT'], list: 'BI_WEEKLY', stage: 'QUALIFY',
    product: ['PHH', 'TOLLBOOTH'], campaigns: ['AY_PHH_POST_WEBINAR'], tags: ['KANBAN_OPPORTUNITY', 'HIGH_PRIORITY_HOT_LEAD'],
    next: ['FU-2', '2026-09-10', 'EMAIL'], note: 'FU 1 done, asked for the PHH one-pager.',
    lastCall: '2026-09-04T14:10:00.000Z', lastEmail: '2026-09-05T08:30:00.000Z', calling: true,
  },
  {
    last: 'Two', co: 'dummy-co-a', title: 'Head of Sales', pod: 'ALISA', owner: 'wm-alisa',
    lead: ['FPA_WISCONSIN_JULY_2026'], tier: 'LEVEL_2', type: ['PROSPECT'], list: 'MONTHLY',
    campaigns: ['AY_PHH_POST_WEBINAR'], tags: ['KANBAN_AWARENESS'], next: ['FU-1', '2026-09-11', 'LINKEDIN_MESSAGE'],
    lastEmail: '2026-09-03T11:00:00.000Z',
  },
  {
    last: 'Three', co: 'dummy-co-a', title: 'CTO', pod: 'ALISA', owner: 'wm-karson',
    lead: ['LEADGEN'], tier: 'LEVEL_3', type: ['PROSPECT'], list: 'QUARTERLY', tags: ['ENRICHMENT_REQUIRED'],
  },
  {
    last: 'Four', co: 'dummy-co-b', title: 'CEO', pod: 'ALISA', owner: 'wm-karson',
    lead: ['TRUST_ALTA_LUNCHEON_JUNE_2026'], tier: 'LEVEL_1', type: ['CLIENTS'], list: 'MONTHLY', stage: 'RETAIN',
    product: ['PHH'], campaigns: ['SPONSORSHIP'], tags: ['CLIENT', 'MISSING_PHONE'],
    note: 'Renewal conversation booked.', lastCall: '2026-09-02T09:00:00.000Z',
    recording: ['https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeetings.mp4', 'https://teams.microsoft.com/l/meetup-join/dummy-four'],
  },
  {
    last: 'Five', co: 'dummy-co-b', title: 'CFO', pod: 'ALISA', owner: null,
    lead: ['LEADGEN', 'NIL'], tier: 'LEVEL_4', type: ['ORGANIZATION'], list: 'COLD_BD', tags: ['MISSING_EMAIL'],
  },
  {
    last: 'Six', co: 'dummy-co-b', title: 'COO', pod: 'ALISA', owner: 'wm-alisa',
    lead: ['WM_EDGE_JUNE_2026'], tier: 'LEVEL_3', type: ['PROSPECT'], list: 'UNASSIGNED', dnd: true,
    note: 'Asked not to be contacted again.',
  },
  {
    last: 'Seven', co: 'dummy-co-c', title: 'Head of Growth', pod: 'ANDREW', owner: 'wm-andrew',
    lead: ['FUTUREPROOF_MAR2026'], tier: 'LEVEL_2', type: ['PROSPECT', 'PARTNER'], list: 'BI_WEEKLY', stage: 'PROSPECT',
    product: ['GLYNAC'], campaigns: ['CE_PRESENTATION'], next: ['Confirm next steps', '2026-09-09', 'EMAIL'],
  },
  {
    last: 'Eight', co: 'dummy-co-c', title: 'Director of Marketing', pod: 'ANDREW', owner: 'wm-andrew',
    lead: ['LEADGEN'], tier: 'LEVEL_3', type: ['PARTNER'], list: 'QUARTERLY', tags: ['PARTNER'],
    note: 'Sent the partner deck.',
  },
  {
    last: 'Nine', co: 'dummy-co-c', title: 'Head of Partnerships', pod: 'ANDREW', owner: 'wm-daniel',
    lead: ['NIL'], tier: 'LEVEL_4', type: ['PROSPECT'], list: 'COLD_BD', tags: ['DNC'],
  },
  {
    last: 'Ten', co: 'dummy-co-a', title: 'Procurement Lead', pod: 'ANDREW', owner: 'wm-daniel',
    lead: ['FDL_EDGE_WEBINAR_JUNE_2026'], tier: 'LEVEL_3', type: ['PROSPECT'], list: 'MONTHLY',
  },
  {
    last: 'Eleven', co: 'dummy-co-b', title: 'VP Product', pod: 'ANDREW', owner: null,
    lead: ['LEADGEN'], tier: 'LEVEL_3', type: ['PROSPECT'], list: 'QUARTERLY', rotatedTo: 'ROTATED_OUT_LEIGH',
  },
  {
    // podOwner KARSON has no pod in Cadence: this is the pod-discovery path.
    last: 'Twelve', co: 'dummy-co-c', title: 'Head of Data', pod: 'KARSON', owner: 'wm-karson',
    lead: ['ORIONASCENTFEB2026'], tier: 'LEVEL_2', type: ['CLIENT_S_CLIENT'], list: 'MONTHLY',
  },
  // Used by the "starting today" campaigns so every pod has work due today.
  {
    last: 'Thirteen', co: 'dummy-co-a', title: 'Head of Finance', pod: 'ALISA', owner: 'wm-alisa',
    lead: ['FPA_WISCONSIN_JULY_2026'], tier: 'LEVEL_2', type: ['PROSPECT'], list: 'BI_WEEKLY',
    campaigns: ['AY_PHH_POST_WEBINAR'], calling: true,
  },
  {
    last: 'Fourteen', co: 'dummy-co-b', title: 'Head of People', pod: 'ALISA', owner: 'wm-karson',
    lead: ['WM_EDGE_JUNE_2026'], tier: 'LEVEL_3', type: ['PROSPECT'], list: 'MONTHLY',
  },
  {
    last: 'Fifteen', co: 'dummy-co-c', title: 'VP Engineering', pod: 'ANDREW', owner: 'wm-andrew',
    lead: ['LEADGEN'], tier: 'LEVEL_3', type: ['PROSPECT'], list: 'QUARTERLY',
  },
  {
    last: 'Sixteen', co: 'dummy-co-a', title: 'Head of Support', pod: 'ANDREW', owner: 'wm-daniel',
    lead: ['NIL'], tier: 'LEVEL_4', type: ['PROSPECT'], list: 'COLD_BD',
  },
];

export const DEMO_PEOPLE: TwentyPerson[] = rows.map((r, i) => {
  const company = DEMO_COMPANIES.find((c) => c.id === r.co)!;
  const n = i + 1;
  const tags = r.tags ?? [];
  return {
    id: `dummy-${String(n).padStart(2, '0')}`,
    firstName: 'Dummy',
    lastName: r.last,
    email: `dummy.${r.last.toLowerCase()}@${company.domain}`,
    additionalEmails: [],
    phone: `+44 20 7000 ${String(1000 + n).padStart(4, '0')}`,
    additionalPhone: null,
    linkedinUrl: `https://www.linkedin.com/in/dummy-${r.last.toLowerCase()}`,
    xUrl: null,
    jobTitle: r.title,
    city: ['London', 'Manchester', 'Berlin'][i % 3],
    companyId: company.id,
    companyName: company.name,

    ownerMemberId: r.owner,
    podOwner: r.pod,
    rotatedTo: r.rotatedTo ?? null,
    rotationChangedAt: r.rotatedTo ? '2026-08-18T10:00:00.000Z' : null,

    dnd: Boolean(r.dnd) || tags.includes('DNC'),
    dndReason: r.dnd ? 'DO_NOT_DISTURB' : tags.includes('DNC') ? 'DNC' : null,
    emailMissing: tags.includes('MISSING_EMAIL'),
    phoneMissing: tags.includes('MISSING_PHONE'),

    tags,
    leadSource: r.lead,
    leadSourceNotes: null,
    tier: r.tier ?? null,
    contactType: r.type ?? [],
    listCategory: r.list ?? null,
    previousCadence: r.list === 'BI_WEEKLY' ? 'MONTHLY' : null,
    pipelineStage: r.stage ?? null,
    productInterest: r.product ?? [],
    primaryProduct: r.product?.[0] ?? null,
    campaigns: r.campaigns ?? [],
    onCallingList: Boolean(r.calling),
    dealSignalStrength: null,

    nextAction: r.next?.[0] ?? null,
    nextActionDueDate: r.next?.[1] ?? null,
    nextStep: r.next?.[2] ?? null,
    nextActionDueDatePoc: null,
    lastNote: r.note ?? null,

    lastCallAt: r.lastCall ?? null,
    lastEmailAt: r.lastEmail ?? null,

    recordingUrl: r.recording?.[0] ?? null,
    meetingUrl: r.recording?.[1] ?? null,
    bookingId: r.recording ? `dummy-booking-${n}` : null,

    createdBySource: 'MANUAL',
    createdByName: 'Admin Acumen',
    createdByMemberId: 'wm-ria',
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
  { id: 'view-alisa-pod', name: "Alisa's pod - all people", objectSingular: 'person', personIds: DEMO_PEOPLE.filter((x) => x.podOwner === 'ALISA').map((x) => x.id) },
  { id: 'view-andrew-pod', name: "Andrew's pod - all people", objectSingular: 'person', personIds: DEMO_PEOPLE.filter((x) => x.podOwner === 'ANDREW').map((x) => x.id) },
  { id: 'view-all-dummies', name: 'All dummy people', objectSingular: 'person', personIds: DEMO_PEOPLE.map((x) => x.id) },
];
