import { describe, expect, it } from 'vitest';
import { normalizeCrd, normalizeDomain, normalizeEmail, normalizeFirmName, normalizeLinkedin, parsePhone, splitE164 } from '@/lib/sandbox/normalize';

/** Contract 14.5: one normalisation for push, manual add, dedupe, calls and mail. */
describe('sandbox normalisation', () => {
  it('lower-cases and trims emails, keeping dots and +tags', () => {
    expect(normalizeEmail('  Jane.Doe+cfp@Example.COM ')).toBe('jane.doe+cfp@example.com');
    expect(normalizeEmail('not an email')).toBeNull();
  });

  it('parses phones to E.164 with the region from the country, splitting the extension', () => {
    expect(parsePhone('(312) 555-0142')).toEqual({ e164: '+13125550142', extension: null });
    expect(parsePhone('312.555.0142 x12')).toEqual({ e164: '+13125550142', extension: '12' });
    expect(parsePhone('1-312-555-0142 ext. 7')).toEqual({ e164: '+13125550142', extension: '7' });
    expect(parsePhone('+44 20 7946 0958')).toEqual({ e164: '+442079460958', extension: null });
    expect(parsePhone('020 7946 0958', 'GB')).toEqual({ e164: '+442079460958', extension: null });
    expect(parsePhone('0044 20 7946 0958')?.e164).toBe('+442079460958');
    expect(parsePhone('555-0142')).toBeNull();
    expect(parsePhone('(123) 555-0142')).toBeNull();
    expect(splitE164('+13125550142')).toEqual({ callingCode: '+1', number: '3125550142', country: 'US' });
  });

  it('reduces LinkedIn to linkedin.com/in/<slug> and drops anything else', () => {
    expect(normalizeLinkedin('https://www.linkedin.com/in/Jane-Doe/?trk=x#a')).toBe('linkedin.com/in/jane-doe');
    expect(normalizeLinkedin('uk.linkedin.com/in/jane-doe/')).toBe('linkedin.com/in/jane-doe');
    expect(normalizeLinkedin('https://www.linkedin.com/company/acme')).toBeNull();
  });

  it('keeps CRD digits without leading zeros, bare domains and loose firm names', () => {
    expect(normalizeCrd('000105943')).toBe('105943');
    expect(normalizeDomain('https://www.Example-Advisors.com/team')).toBe('example-advisors.com');
    expect(normalizeFirmName('The Example Advisors, LLC')).toBe(normalizeFirmName('example advisors inc.'));
  });

});
