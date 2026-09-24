import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportDocument, type ReportDocumentProps } from '@/components/reports/report-document';
import { REPORT_EXPORT_STYLES } from '@/lib/report-export-styles';
import type { Reports } from '@/lib/reports-query';

const group = (key: string, label: string, n: number) => ({ key, label, enrolled: 4 * n, active: 2, replied: n, meeting: n, completed: 0, exited: 0, replyRate: 0.25 * n, meetingRate: 0.25 * n, tasksDone: 6 * n, tasksSkipped: 1, overdue: 0 });
const report = (n: number) => ({
  today: '2026-09-24', range: { from: '2026-09-01', to: '2026-09-24' },
  daily: [{ date: '2026-09-23', enrollments: 2 * n, tasksDone: 3 * n, replies: n, meetings: 0, byChannel: { EMAIL: n, CALL: n, LINKEDIN: n } }, { date: '2026-09-24', enrollments: 2 * n, tasksDone: 3 * n, replies: 0, meetings: n, byChannel: { EMAIL: 2 * n, CALL: n, LINKEDIN: 0 } }],
  funnel: { enrolled: 4 * n, touched: 3 * n, replied: n, meeting: n },
  activity: n ? [{ id: 'fo', name: 'Alyssa', period: { emails: 3 * n, calls: 2 * n, answered: n, linkedin: n, observed: 2, total: 6 * n, replies: n, meetings: n } }] : [],
  totals: { enrollments: 4 * n, active: 2, replied: n, meeting: n, tasksDone: 6 * n },
  byPod: n ? [group('pod', "Alisa's pod", n)] : [], byFo: n ? [group('fo', 'Alyssa', n)] : [], byCampaign: n ? [group('c', 'Late September', n)] : [],
  channels: n ? [{ action: 'EMAIL', label: 'Email', pending: 2, overdue: 0, done: 3 * n, observed: 2, manual: 1, skipped: 1, cancelled: 0 }] : [],
}) as unknown as Reports;
const campaigns = [
  { id: 'a', name: 'Late September', podName: "Alisa's pod", startDate: '2026-09-24', endDate: '2026-09-30', day: 1, total: 7, touchesDone: 1, touchesPlanned: 1, replied: 1, meetings: 1 },
  { id: 'b', name: 'Older', podName: "Andrew's pod", startDate: '2026-09-01', endDate: null, day: 24, total: null, touchesDone: 3, touchesPlanned: 9, replied: 0, meetings: 2 },
  { id: 'c', name: 'Today', podName: "Andrew's pod", startDate: '2026-09-24', endDate: null, day: 1, total: null, touchesDone: 0, touchesPlanned: 4, replied: 0, meetings: 0 },
];
const base: ReportDocumentProps = { reports: report(2), previous: report(1), range: { from: '2026-09-01', to: '2026-09-24' }, compared: { from: '2026-08-01', to: '2026-08-24' }, scope: 'All pods', campaigns, generatedBy: 'Admin', generatedAt: new Date('2026-09-24T12:00:00Z') };
// Up, down and unchanged figures; no earlier period; an empty period with no campaigns.
const variants: ReportDocumentProps[] = [base, { ...base, reports: report(1), previous: report(2) }, { ...base, previous: report(2), reports: report(2) }, { ...base, previous: null, compared: null }, { ...base, reports: report(0), previous: report(0), campaigns: [] }];

/** Tailwind's class name as it appears in a stylesheet selector. */
const escape = (cls: string) => cls.replace(/[[\](),.:/%#!']/g, (c) => `\\${c}`);
const ruleFor = (cls: string) => new RegExp(`\\.${escape(cls).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,{:>])`);
// Classes that only group or mark elements, styled through a parent rule.
const STRUCTURAL = new Set(['num', 'table-dense']);

describe('the exported report', () => {
  const used = new Set(variants.flatMap((props) => [...renderToStaticMarkup(createElement(ReportDocument, props)).matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean))));

  it('has its own style rule for every class the document uses, in every state', () => {
    expect([...used].filter((cls) => !STRUCTURAL.has(cls) && !ruleFor(cls).test(REPORT_EXPORT_STYLES))).toEqual([]);
  });

  it('carries no rule for a class the document no longer uses', () => {
    // Only the selector side of each rule: values such as 1.5 or -0.02em are not class names.
    const heads = REPORT_EXPORT_STYLES.split('}').map((rule) => rule.split('{').at(-2) ?? '');
    const selectors = heads.flatMap((head) => [...head.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, '$1')));
    // Base classes the table and surfaces are built on, written as element rules under them.
    const always = new Set(['surface', 'table']);
    expect([...new Set(selectors)].filter((cls) => !used.has(cls) && !always.has(cls))).toEqual([]);
  });
});
