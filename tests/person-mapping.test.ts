import { describe, expect, it } from 'vitest';
import { normalizePerson } from '@/lib/twenty/normalize';
import { mergeTwentySchema } from '@/lib/twenty/twenty-schema';
import { personToCacheData } from '@/lib/person-cache';

/**
 * The mapping between Twenty's field names and Cadence's, checked against a record shaped
 * exactly like the real workspace's. Every value below was taken from a full export of Alisa's
 * pod, including the ones that used to be mapped wrongly: the owner is `assignedTo`, `dnd` is a
 * select rather than a boolean, and where-we-met is `leadSource`, a multi-select.
 */
const schema = mergeTwentySchema();

const raw = {
  id: '24bc8dac-76a2-4967-a061-148352e60a30',
  name: { firstName: 'Feliks', lastName: 'Zolchistyy' },
  emails: { primaryEmail: 'feliks@firstwilshire.com', additionalEmails: ['f.zolchistyy@firstwilshire.com'] },
  // The export carries a zero-width joiner inside the calling code.
  phones: { primaryPhoneNumber: '7862200330', primaryPhoneCallingCode: '‍+1', primaryPhoneCountryCode: 'US' },
  additionalNumber: { primaryPhoneNumber: '4142531435', primaryPhoneCallingCode: '‍+1', primaryPhoneCountryCode: 'US' },
  linkedinLink: { primaryLinkUrl: 'https://www.linkedin.com/in/feliks-z' },
  xLink: { primaryLinkUrl: null },
  jobTitle: 'Senior Financial Advisor',
  city: 'Chicago, Illinois',
  companyId: 'e0b62441-0459-4f69-ba5f-5caaaee3b76f',
  company: { id: 'e0b62441-0459-4f69-ba5f-5caaaee3b76f', name: 'First Wilshire' },
  createdBy: { source: 'MANUAL', workspaceMemberId: '37cac685-91e0-4518-8a69-378d81c546ea', name: 'Vicky Nandakumar' },

  assignedToId: '4aaba3a5-e72b-4fe4-b80f-bef2c16f271b',
  podOwner: 'ALISA',
  rotationTracking: 'ROTATED_OUT_LEIGH',
  rotationChangedAt: '2026-08-18T10:00:00.000Z',

  dnd: 'DO_NOT_DISTURB',
  tags: ['KANBAN_OPPORTUNITY', 'MISSING_PHONE', 'ALISA'],
  leadSource: ['FPA_WISCONSIN_JULY_2026', 'LEADGEN'],
  leadSourceNotes: 'Private Wealth Midwest Forum',
  tier: 'LEVEL_3',
  contactType: ['PROSPECT', 'PARTNER'],
  listCategory: 'QUARTERLY',
  previousCadence: 'MONTHLY',
  pipelineStageField: 'QUALIFY',
  productInterest: ['PHH', 'ACUBOOTH'],
  primaryProduct: 'PHH',
  onGoingCampaigns: ['AY_PHH_POST_WEBINAR', 'SPONSORSHIP'],
  alisaCallingList: true,
  dealSignalStrength: null,

  nextAction: 'FU-2',
  nextActionDueDate: '2026-09-14',
  nextStep: 'LINKEDIN_MESSAGE',
  nextActionDueDatePoc: '2026-08-31T00:00:00.000Z',
  lastNote: 'Send the material for PHH+TOLLBOOTH',

  latestCallActivity: '2026-08-14T20:17:33.000Z',
  lastEmailActivity: '2026-08-08T13:26:19.000Z',

  meetingLink: { primaryLinkUrl: 'https://teams.microsoft.com/l/meetup-join/x' },
  salesCallRecordingLink: { primaryLinkUrl: 'https://contoso.sharepoint.com/x/Recording.mp4' },
  bookingId: 'BK-1029',

  createdAt: '2026-09-07T10:59:43.563Z',
  updatedAt: '2026-09-07T11:03:14.860Z',
  deletedAt: null,
};

describe('normalizePerson against the real workspace', () => {
  const p = normalizePerson(raw, schema);

  it('reads identity and contact details, and strips the joiner from the calling code', () => {
    expect(p.firstName).toBe('Feliks');
    expect(p.lastName).toBe('Zolchistyy');
    expect(p.email).toBe('feliks@firstwilshire.com');
    expect(p.additionalEmails).toEqual(['f.zolchistyy@firstwilshire.com']);
    expect(p.phone).toBe('+1 7862200330');
    expect(p.additionalPhone).toBe('+1 4142531435');
    expect(p.linkedinUrl).toBe('https://www.linkedin.com/in/feliks-z');
    expect(p.xUrl).toBeNull();
    expect(p.city).toBe('Chicago, Illinois');
    expect(p.companyName).toBe('First Wilshire');
  });

  it('takes the owner from assignedTo, not from an invented owner field', () => {
    expect(p.ownerMemberId).toBe('4aaba3a5-e72b-4fe4-b80f-bef2c16f271b');
    expect(p.podOwner).toBe('ALISA');
    expect(p.rotatedTo).toBe('ROTATED_OUT_LEIGH');
  });

  it('treats dnd as a select and reads consent and data quality from the tags', () => {
    expect(p.dnd).toBe(true);
    expect(p.dndReason).toBe('DO_NOT_DISTURB');
    expect(p.phoneMissing).toBe(true);
    expect(p.emailMissing).toBe(false);
  });

  it('reads the classification fields, single and multi-select alike', () => {
    expect(p.leadSource).toEqual(['FPA_WISCONSIN_JULY_2026', 'LEADGEN']);
    expect(p.leadSourceNotes).toBe('Private Wealth Midwest Forum');
    expect(p.tier).toBe('LEVEL_3');
    expect(p.contactType).toEqual(['PROSPECT', 'PARTNER']);
    expect(p.listCategory).toBe('QUARTERLY');
    expect(p.previousCadence).toBe('MONTHLY');
    expect(p.pipelineStage).toBe('QUALIFY');
    expect(p.productInterest).toEqual(['PHH', 'ACUBOOTH']);
    expect(p.primaryProduct).toBe('PHH');
    expect(p.campaigns).toEqual(['AY_PHH_POST_WEBINAR', 'SPONSORSHIP']);
    expect(p.onCallingList).toBe(true);
  });

  it('reads the next action, keeping dates as plain local dates', () => {
    expect(p.nextAction).toBe('FU-2');
    expect(p.nextActionDueDate).toBe('2026-09-14');
    expect(p.nextStep).toBe('LINKEDIN_MESSAGE');
    // A date field can arrive as a full timestamp; only the date part is kept.
    expect(p.nextActionDueDatePoc).toBe('2026-08-31');
    expect(p.lastNote).toBe('Send the material for PHH+TOLLBOOTH');
  });

  it('reads the last-touch stamps and the links Twenty keeps', () => {
    expect(p.lastCallAt).toBe('2026-08-14T20:17:33.000Z');
    expect(p.lastEmailAt).toBe('2026-08-08T13:26:19.000Z');
    expect(p.recordingUrl).toBe('https://contoso.sharepoint.com/x/Recording.mp4');
    expect(p.meetingUrl).toBe('https://teams.microsoft.com/l/meetup-join/x');
    expect(p.bookingId).toBe('BK-1029');
  });

  it('keeps who added the record', () => {
    expect(p.createdBySource).toBe('MANUAL');
    expect(p.createdByName).toBe('Vicky Nandakumar');
    expect(p.createdByMemberId).toBe('37cac685-91e0-4518-8a69-378d81c546ea');
  });

  it('an empty record does not crash and yields nothing rather than false values', () => {
    const empty = normalizePerson({ id: 'x', updatedAt: '2026-09-01T00:00:00.000Z' }, schema);
    expect(empty.dnd).toBe(false);
    expect(empty.dndReason).toBeNull();
    expect(empty.leadSource).toEqual([]);
    expect(empty.contactType).toEqual([]);
    expect(empty.tier).toBeNull();
    expect(empty.onCallingList).toBe(false);
    expect(empty.recordingUrl).toBeNull();
  });

  it('reads a multi-select that arrives as a JSON string, which is how exports write it', () => {
    const fromExport = normalizePerson({ ...raw, leadSource: '["NIL","LEADGEN"]', contactType: 'PROSPECT' }, schema);
    expect(fromExport.leadSource).toEqual(['NIL', 'LEADGEN']);
    expect(fromExport.contactType).toEqual(['PROSPECT']);
  });

  it('a do-not-contact tag alone is enough, for the records that use it instead of the select', () => {
    const tagged = normalizePerson({ ...raw, dnd: null, tags: ['DNC'] }, schema);
    expect(tagged.dnd).toBe(true);
    expect(tagged.dndReason).toBe('DNC');
  });

  it('every mapped field reaches the person cache', () => {
    const data = personToCacheData(p);
    expect(data).toMatchObject({
      ownerMemberId: '4aaba3a5-e72b-4fe4-b80f-bef2c16f271b',
      podOwner: 'ALISA',
      dnd: true,
      dndReason: 'DO_NOT_DISTURB',
      phoneMissing: true,
      leadSource: ['FPA_WISCONSIN_JULY_2026', 'LEADGEN'],
      tier: 'LEVEL_3',
      contactType: ['PROSPECT', 'PARTNER'],
      listCategory: 'QUARTERLY',
      pipelineStage: 'QUALIFY',
      productInterest: ['PHH', 'ACUBOOTH'],
      campaigns: ['AY_PHH_POST_WEBINAR', 'SPONSORSHIP'],
      onCallingList: true,
      nextAction: 'FU-2',
      nextActionDueDate: '2026-09-14',
      nextStep: 'LINKEDIN_MESSAGE',
      lastNote: 'Send the material for PHH+TOLLBOOTH',
      bookingId: 'BK-1029',
      createdByName: 'Vicky Nandakumar',
    });
    // Timestamps become Dates; an unparseable one is dropped rather than stored as 1970.
    expect(data.lastCallAt).toEqual(new Date('2026-08-14T20:17:33.000Z'));
    expect(data.lastEmailAt).toEqual(new Date('2026-08-08T13:26:19.000Z'));
    expect(personToCacheData({ ...p, lastCallAt: 'not a date' }).lastCallAt).toBeNull();
  });

  it('follows a renamed field without touching anything else', () => {
    const renamed = mergeTwentySchema({ person: { assignedToId: 'relationshipOwnerId', tier: 'grade' } });
    const q = normalizePerson({ ...raw, relationshipOwnerId: 'wm-9', grade: 'LEVEL_1' }, renamed);
    expect(q.ownerMemberId).toBe('wm-9');
    expect(q.tier).toBe('LEVEL_1');
    expect(q.listCategory).toBe('QUARTERLY');
  });
});
