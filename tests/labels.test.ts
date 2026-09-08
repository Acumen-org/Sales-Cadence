import { describe, expect, it } from 'vitest';
import { optionLabel, optionLabels, tierRank } from '@/lib/twenty/labels';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';

/**
 * Twenty's option values are constants; these are the labels an FO reads. The cases below are
 * real values from Alisa's pod, including the ones a naive underscore-to-space would mangle.
 */
describe('optionLabel', () => {
  it('turns constants into readable text and keeps the team acronyms', () => {
    expect(optionLabel('ALISA')).toBe('Alisa');
    expect(optionLabel('FPA_WISCONSIN_JULY_2026')).toBe('FPA Wisconsin July 2026');
    expect(optionLabel('AY_PHH_POST_WEBINAR')).toBe('AY PHH post-webinar');
    expect(optionLabel('WM_EDGE_JUNE_2026')).toBe('WM Edge June 2026');
    expect(optionLabel('TRUST_ALTA_LUNCHEON_JUNE_2026')).toBe('Trust Alta Luncheon June 2026');
    expect(optionLabel('AUBURN_HILL_ACQUISITION')).toBe('Auburn Hill Acquisition');
    expect(optionLabel('NIL')).toBe('NIL');
    expect(optionLabel('PHH')).toBe('PHH');
  });

  it('splits a run-together trailing year', () => {
    expect(optionLabel('FUTUREPROOF_MAR2026')).toBe('Futureproof Mar 2026');
    expect(optionLabel('FPAMIAMIFEB2026')).toBe('Fpamiamifeb 2026');
  });

  it('uses the overrides where the general rule would read badly', () => {
    expect(optionLabel('LEVEL_1')).toBe('Tier 1');
    expect(optionLabel('LEVEL_4')).toBe('Tier 4');
    expect(optionLabel('CLIENT_S_CLIENT')).toBe("Client's client");
    expect(optionLabel('BI_WEEKLY')).toBe('Bi-weekly');
    expect(optionLabel('COLD_BD')).toBe('Cold BD');
    expect(optionLabel('DO_NOT_DISTURB')).toBe('Do not contact');
    expect(optionLabel('LINKEDIN_MESSAGE')).toBe('LinkedIn message');
    expect(optionLabel('MISSING_PHONE')).toBe('Phone missing');
    expect(optionLabel('ROTATED_OUT_LEIGH')).toBe('Rotated out to Leigh');
    expect(optionLabel('WEALTH_MANAGEMENT_FIRMS_IL_WI_IN')).toBe('Wealth management firms (IL, WI, IN)');
  });

  it('leaves prose and free text alone', () => {
    expect(optionLabel('Chicago, Illinois')).toBe('Chicago, Illinois');
    expect(optionLabel('Send the material for PHH+TOLLBOOTH')).toBe('Send the material for PHH+TOLLBOOTH');
    expect(optionLabel('FU 1')).toBe('FU 1');
    expect(optionLabel(null)).toBe('');
    expect(optionLabel('  ')).toBe('');
  });

  it('joins several values and drops the empty ones', () => {
    expect(optionLabels(['PROSPECT', 'PARTNER'], ' / ')).toBe('Prospect / Partner');
    expect(optionLabels([])).toBe('');
    expect(optionLabels(null)).toBe('');
  });

  it('every option the mapping knows produces a non-empty label', () => {
    for (const list of Object.values(defaultTwentySchema.personValues)) {
      for (const value of list) expect(optionLabel(value), value).not.toBe('');
    }
  });
});

describe('tierRank', () => {
  const order = defaultTwentySchema.personValues.tier;

  it('ranks the best tier first and puts the unknown ones last', () => {
    expect(tierRank('LEVEL_1', order)).toBe(0);
    expect(tierRank('LEVEL_4', order)).toBe(3);
    expect(tierRank('LEVEL_9', order)).toBe(order.length);
    expect(tierRank(null, order)).toBe(order.length + 1);
  });
});
