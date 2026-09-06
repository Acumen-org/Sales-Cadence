import { describe, expect, it } from 'vitest';
import { defaultNoteTitlePatterns, defaultTwentySchema, mergeTwentySchema } from '@/lib/twenty/twenty-schema';

describe('twenty schema mapping', () => {
  it('defaults expose the custom person fields', () => {
    expect(defaultTwentySchema.person.dnd).toBe('dnd');
    expect(defaultTwentySchema.person.podOwner).toBe('podOwner');
    expect(defaultTwentySchema.person.eventSource).toBe('eventSource');
    expect(defaultTwentySchema.podOwnerOptions).toContain('Alisa');
  });

  it('merges overrides without losing defaults', () => {
    const merged = mergeTwentySchema({
      person: { dnd: 'doNotContact', podOwner: '  podOwnerV2 ' },
      objects: { person: { plural: 'persons' } },
      podOwnerOptions: ['A', 'B'],
    });
    expect(merged.person.dnd).toBe('doNotContact');
    expect(merged.person.podOwner).toBe('podOwnerV2');
    expect(merged.person.jobTitle).toBe('jobTitle');
    expect(merged.objects.person.plural).toBe('persons');
    expect(merged.objects.person.singular).toBe('person');
    expect(merged.podOwnerOptions).toEqual(['A', 'B']);
    expect(merged.note.body).toBe('bodyV2');
  });

  it('ignores empty override values', () => {
    const merged = mergeTwentySchema({ person: { dnd: '' }, podOwnerOptions: [] });
    expect(merged.person.dnd).toBe('dnd');
    expect(merged.podOwnerOptions.length).toBeGreaterThan(0);
  });

  it('default note title patterns are valid regexes that match the fixtures', () => {
    const email = new RegExp(defaultNoteTitlePatterns.outboundEmail, 'i');
    const call = new RegExp(defaultNoteTitlePatterns.outboundCall, 'i');
    const notes = new RegExp(defaultNoteTitlePatterns.callNotes, 'i');
    expect(email.test('[Email] Outbound email: Intro to Acme Logistics')).toBe(true);
    expect(call.exec('[CALL] Outbound Call by tw_alisa')?.groups?.actor).toBe('tw_alisa');
    expect(notes.exec('Call Notes [31-Aug-2026]')?.groups?.date).toBe('31-Aug-2026');
    expect(email.test('[Cadence] Email 2 sent by Alisa')).toBe(false);
    expect(call.test('Meeting prep: Northwind Traders')).toBe(false);
  });
});
