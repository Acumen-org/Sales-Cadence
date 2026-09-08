import { describe, expect, it } from 'vitest';
import { defaultNoteTitlePatterns, defaultTwentySchema, mergeTwentySchema } from '@/lib/twenty/twenty-schema';

describe('twenty schema mapping', () => {
  it('defaults expose the real custom person fields', () => {
    expect(defaultTwentySchema.person.dnd).toBe('dnd');
    expect(defaultTwentySchema.person.podOwner).toBe('podOwner');
    // The owner of a relationship is Twenty's `assignedTo`, not an invented `owner` field.
    expect(defaultTwentySchema.person.assignedToId).toBe('assignedToId');
    expect(defaultTwentySchema.person.leadSource).toBe('leadSource');
    expect(defaultTwentySchema.person.pipelineStageField).toBe('pipelineStageField');
    expect(defaultTwentySchema.person.callingList).toBe('alisaCallingList');
    expect(defaultTwentySchema.podOwnerOptions).toContain('ALISA');
    // dnd is a select in this workspace, and its set value is what makes it true.
    expect(defaultTwentySchema.personValues.dnd).toEqual(['DO_NOT_DISTURB']);
    expect(defaultTwentySchema.personValues.tier).toEqual(['LEVEL_1', 'LEVEL_2', 'LEVEL_3', 'LEVEL_4']);
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

  it('an option-list override replaces that list and leaves the others alone', () => {
    const merged = mergeTwentySchema({ personValues: { tier: ['A', ' B ', ''], listCategory: [] } });
    expect(merged.personValues.tier).toEqual(['A', 'B']);
    expect(merged.personValues.listCategory).toEqual(['COLD_BD', 'BI_WEEKLY', 'MONTHLY', 'QUARTERLY', 'UNASSIGNED']);
    expect(merged.personValues.dnd).toEqual(['DO_NOT_DISTURB']);
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
