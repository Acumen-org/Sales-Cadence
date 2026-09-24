import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CampaignCalendarView } from '@/components/campaigns/campaign-calendar';
import type { CampaignCalendar, CampaignDraft } from '@/lib/campaign-planner';

/**
 * The calendar opens on every FO at once. Each working day lists its FOs with how many people they
 * reach, in the dropdown's order every day so a row belongs to one FO: all of them up to eight, or
 * seven and "+N more FOs". It holds for any team size.
 */
describe('the campaign calendar with many FOs', () => {
  const days = ['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08'];
  const fos = Array.from({ length: 10 }, (_, i) => ({ id: `fo-${i}`, name: `FO ${String.fromCharCode(65 + i)}`, twentyMemberId: null }));
  // FO J reaches the most people and FO A the fewest; every FO has something every working day.
  const batches = fos.flatMap((fo, i) => days.map((day, d) => ({ id: `${fo.id}:${d}`, foId: fo.id, flowId: 'default', personIds: Array.from({ length: 1 + i }, (_, k) => `${fo.id}-${d}-${k}`), dates: [day], priority: 5 })));
  const calendar: CampaignCalendar = { version: 1, days, batches, people: [], fos, issues: [], valid: true, exhausted: false };
  const draft = { name: 'Big team', podId: 'pod', startDate: days[0], endDate: days.at(-1)!, productInterest: [], defaultBatchSize: 1, fos: fos.map((f) => ({ id: f.id, batchSize: 1 })), personIds: [], assignments: {}, flows: [{ id: 'default', name: 'Default', steps: [{ id: 'one', day: 1, actions: [{ id: 'email', type: 'EMAIL', label: 'Email' }] }] }] } as unknown as CampaignDraft;
  const html = renderToStaticMarkup(createElement(CampaignCalendarView, { draft, calendar }));
  const monday = html.slice(html.indexOf('data-day="2027-01-04"'), html.indexOf('data-day="2027-01-05"'));

  it('opens on All FOs, with every FO in the dropdown', () => {
    expect(html).toMatch(/<select aria-label="Calendar FO"[^>]*>.*<option value="all" selected="">All FOs<\/option>/);
    for (const fo of fos) expect(html).toContain(`<option value="${fo.id}">${fo.name}</option>`);
  });

  it('lists the first seven FOs in the same order every day and puts the rest behind a count', () => {
    for (const name of ['FO A', 'FO B', 'FO C', 'FO D', 'FO E', 'FO F', 'FO G']) expect(monday).toContain(`Show ${name}&#x27;s calendar`);
    for (const name of ['FO H', 'FO I', 'FO J']) expect(monday).not.toContain(`Show ${name}&#x27;s calendar`);
    expect(monday).toContain('+3 more FOs');
    // No batch cards until one FO is chosen; the day still says how many people it reaches in all.
    expect(html).not.toContain('Step 1 <');
    expect(monday).toContain(`${Array.from({ length: 10 }, (_, i) => i + 1).reduce((n, x) => n + x, 0)} people`);
  });

  it('lists everyone when the team fits in a day', () => {
    const eight = { ...calendar, fos: fos.slice(0, 8), batches: batches.filter((x) => fos.slice(0, 8).some((f) => f.id === x.foId)) };
    const day = renderToStaticMarkup(createElement(CampaignCalendarView, { draft, calendar: eight }));
    const cell = day.slice(day.indexOf('data-day="2027-01-04"'), day.indexOf('data-day="2027-01-05"'));
    for (const fo of fos.slice(0, 8)) expect(cell).toContain(`Show ${fo.name}&#x27;s calendar`);
    expect(cell).not.toContain('more FOs');
  });

  it('puts the dots on the whole calendar, not on each day', () => {
    expect(html.match(/calendar-dots/g)).toHaveLength(1);
    expect(html).toMatch(/class="calendar-dots grid/);
  });
});
