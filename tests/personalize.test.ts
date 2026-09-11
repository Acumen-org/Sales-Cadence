import { describe, expect, it } from 'vitest';
import { hasUnknownToken, personalize, personalizeAction } from '@/lib/sequences/personalize';

const ctx = { person: { firstName: 'Nina', lastName: 'Halvorsen', companyName: 'Dummy Company A', jobTitle: 'VP Operations', city: 'London' }, fo: { name: 'Alisa Senior' } };

describe('copy personalises itself when the task is created', () => {
  it('fills every token, in any case and spacing', () => {
    expect(personalize('Hi {{firstName}}, {{ company }} and {{FOFIRSTNAME}} - {{foName}} {{fullName}} {{jobTitle}} {{city}} {{lastName}}', ctx)).toBe(
      'Hi Nina, Dummy Company A and Alisa - Alisa Senior Nina Halvorsen VP Operations London Halvorsen',
    );
  });
  it('never leaves "Hi ," behind when the record is blank', () => {
    const blank = { person: { firstName: '', lastName: '', companyName: null, jobTitle: null, city: null }, fo: { name: 'Alisa Senior' } };
    expect(personalize('Hi {{firstName}}, how is {{company}}? {{jobTitle}}', blank)).toBe('Hi there, how is your firm? ');
  });
  it('drops a token nobody fills, and names it for the editor', () => {
    expect(personalize('Dear {{salutation}} {{firstName}}', ctx)).toBe('Dear  Nina');
    expect(hasUnknownToken('Dear {{salutation}}')).toBe('salutation');
    expect(hasUnknownToken('Dear {{firstName}}')).toBeNull();
  });
  it('personalises subject, text and html of a module alike', () => {
    const a = personalizeAction({ id: 'a', type: 'EMAIL', label: 'Email', subject: 'For {{company}}', template: 'Hi {{firstName}}', bodyHtml: '<p>Hi {{firstName}}</p>' }, ctx);
    expect(a).toMatchObject({ subject: 'For Dummy Company A', template: 'Hi Nina', bodyHtml: '<p>Hi Nina</p>' });
  });
});
