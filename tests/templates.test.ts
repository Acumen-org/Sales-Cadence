import { describe, expect, it } from 'vitest';
import { renderTemplate, unknownVariables } from '@/lib/templates';

describe('renderTemplate', () => {
  it('fills the documented variables', () => {
    const out = renderTemplate('Hi {{firstName}} at {{company}} ({{jobTitle}}), met at {{eventSource}}. - {{foFirstName}}', {
      firstName: 'Nina',
      company: 'Acme Logistics',
      jobTitle: 'VP Operations',
      eventSource: 'SaaStr 2026',
      foFirstName: 'Alisa',
    });
    expect(out).toBe('Hi Nina at Acme Logistics (VP Operations), met at SaaStr 2026. - Alisa');
  });

  it('derives foFirstName from foName and blanks unknowns', () => {
    expect(renderTemplate('{{foFirstName}} / {{fullName}} / {{ nope }}', { foName: 'Alisa Marsh', firstName: 'Nina', lastName: 'Halvorsen' })).toBe(
      'Alisa / Nina Halvorsen / ',
    );
  });

  it('tolerates whitespace and null values', () => {
    expect(renderTemplate('{{ firstName }}-{{company}}', { firstName: null, company: undefined })).toBe('-');
    expect(renderTemplate(null, {})).toBe('');
  });

  it('reports unknown variables', () => {
    expect(unknownVariables('{{firstName}} {{foo}} {{bar}} {{foo}}')).toEqual(['foo', 'bar']);
  });
});
