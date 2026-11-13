import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { callingHoursBlock, callPlace, recordingNotice } from '@/lib/calls/hours';
import { contactability } from '@/lib/outreach/contactability';
import { coldRef } from '@/lib/subject';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/** Audit M02, M03 (owner, 13 Nov 2026): 8am to 9pm in the contact's zone, 2 calls a day, a recording notice where all must agree. */
describe('calling hours, daily attempts and the recording notice', () => {
  it('uses the contact\'s state, else the firm\'s, else US Eastern, and says when it guessed', () => {
    expect(callPlace({ state: 'IL' })).toEqual(expect.objectContaining({ zones: ['America/Chicago'], guessed: null }));
    expect(callPlace({ state: 'Chicago, IL' }).state).toBe('IL');
    expect(callPlace({}, { state: 'California' })).toEqual(expect.objectContaining({ zones: ['America/Los_Angeles'], guessed: expect.stringContaining("firm's state") }));
    expect(callPlace({})).toEqual(expect.objectContaining({ zones: ['America/New_York'], guessed: expect.stringContaining('US Eastern') }));
  });

  it('allows 8:00 to 20:59 local, in every zone of a state that has two', () => {
    const ny = callPlace({ state: 'NY' });
    expect(callingHoursBlock(ny, new Date('2026-11-10T12:59:00Z'))).toEqual(expect.stringContaining('8am to 9pm')); // 7:59 ET
    expect(callingHoursBlock(ny, new Date('2026-11-10T13:00:00Z'))).toBeNull(); // 8:00 ET
    expect(callingHoursBlock(ny, new Date('2026-11-11T01:59:00Z'))).toBeNull(); // 20:59 ET
    expect(callingHoursBlock(ny, new Date('2026-11-11T02:00:00Z'))).not.toBeNull(); // 21:00 ET
    // Texas spans Central and Mountain: 8:30 Central is 7:30 Mountain, too early.
    expect(callingHoursBlock(callPlace({ state: 'TX' }), new Date('2026-11-10T14:30:00Z'))).not.toBeNull();
    expect(callingHoursBlock(callPlace({}), new Date('2026-11-11T02:30:00Z'))).toEqual(expect.stringContaining('US Eastern'));
  });

  it('gives the recording notice in two-party-consent states and abroad only', () => {
    expect(recordingNotice(callPlace({ state: 'CA' }))).toEqual(expect.stringContaining('This call is recorded'));
    expect(recordingNotice(callPlace({ state: 'TX' }))).toBeNull();
    expect(recordingNotice(callPlace({ state: null, country: 'GB' }))).not.toBeNull();
  });

  describe('at the click', () => {
    let b: Basics;
    beforeEach(async () => { await resetDb(); b = await seedBasics(); });

    it('refuses a third call to the same person on their calendar day, and allows it the next day', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { state: 'IL' });
      const noon = new Date('2026-11-10T18:00:00Z'); // 12:00 in Chicago
      for (const h of [1, 2]) await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date(noon.getTime() - h * 3600_000), formDoneAt: noon } });
      expect(await contactability(coldRef(c.id), { act: 'call', number: c.phone, now: noon })).toEqual(expect.objectContaining({ ok: false, block: 'call_limit', reason: expect.stringContaining('2 times today') }));
      // Planning a call is not a call.
      expect((await contactability(coldRef(c.id), { act: 'next_step', channel: 'CALL', now: noon })).ok).toBe(true);
      expect(await contactability(coldRef(c.id), { act: 'call', number: c.phone, now: new Date('2026-11-11T18:00:00Z') })).toEqual(expect.objectContaining({ ok: true, warning: expect.stringContaining('Recording notice') }));
    });
  });
});
