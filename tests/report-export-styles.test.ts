import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportDocument, type ReportDocumentProps } from '@/components/reports/report-document';
import { REPORT_EXPORT_STYLES } from '@/lib/report-export-styles';
import type { Reports } from '@/lib/reports-query';
import { CallsDocument, type CallsDocumentProps } from '@/components/reports/calls-report';
import type { CallReport } from '@/lib/calls/analytics';

const group = (key: string, label: string, n: number, cold = false) => ({ key, label, sent: 6 * n, emails: 3 * n, calls: 2 * n, answered: n, linkedin: n, reached: 4 * n, replies: n, meetings: n, booked: n, replyRate: n / 6, meetingRate: n / 6, cold });
const activity = (n: number) => ({ sent: 3 * n, emails: n, calls: n, linkedin: n, dials: 2 * n, connects: n, replies: n, meetings: n, booked: n });
const people = (n: number) => ({ all: 4 * n, crm: 3 * n, cold: n + 1, both: n ? 1 : 0 });
const bucket = (from: string, n: number) => ({ from, to: from, label: from.slice(5), emails: n, calls: n, linkedin: 0, sent: 2 * n, replies: n, meetings: 0 });
const report = (n: number, audience: 'all' | 'crm' | 'cold' = 'all') => ({
  today: '2026-09-24', audience, range: { from: '2026-09-01', to: '2026-09-24' }, unit: 'day',
  parts: { crm: activity(n), cold: activity(n), unmatched: { ...activity(0), dials: n, sent: n } },
  people: { reached: people(n), replied: people(n) },
  cold: audience === 'cold' ? { funnel: { added: 9 * n, fromBellwether: 6 * n, claimed: 5 * n, worked: 4 * n, connected: 2 * n, booked: n, moved: n, optedOut: 1, removed: 0 }, byRep: n ? [{ key: 'fo', label: 'Alyssa', claimed: n, worked: n, connected: n, booked: n, moved: n }] : [] } : null,
  series: [bucket('2026-09-23', n), bucket('2026-09-24', 2 * n)],
  totals: { sent: 6 * n, emails: 3 * n, calls: 2 * n, answered: n, linkedin: n, reached: 4 * n, replies: n, repliedPeople: n, meetings: n, booked: n, dials: 2 * n, connects: n, replyRate: n / 6, meetingRate: n / 6, doNotContactEmails: n },
  sentByChannel: [{ key: 'EMAIL', label: 'Email', value: 3 * n }, { key: 'CALL', label: 'Calls', value: 2 * n }, { key: 'LINKEDIN', label: 'LinkedIn', value: n }],
  meetingsByProduct: n ? [{ key: 'PHH', label: 'PHH', value: n }, { key: 'none', label: 'No product', value: 1 }] : [],
  byPod: n ? [group('pod', "Alisa's pod", n)] : [], byFo: n ? [group('fo', 'Alyssa', n)] : [], byCampaign: n ? [group('c', 'Late September', n), group('d', 'Cold Q4', n, true)] : [],
  byProduct: n ? [group('PHH', 'PHH', n), group('none', 'No product', n)] : [],
  channels: n ? [{ action: 'EMAIL', label: 'Email', done: 3 * n, observed: 2, manual: 1, skipped: 1, open: 2, overdue: 0 }] : [],
  linkedin: { totals: { requests: 4 * n, accepted: n, acceptanceRate: n ? 0.25 : 0, messages: 2 * n, replies: n, open: n, overdue: 0 }, byRep: n ? [{ key: 'fo', label: 'Alyssa', requests: 4 * n, accepted: n, acceptanceRate: 0.25, messages: 2 * n, replies: n, open: n, overdue: 0 }] : [] },
}) as unknown as Reports;
const campaigns = [
  { id: 'a', name: 'Late September', podName: "Alisa's pod", products: ['PHH'], paused: false, startDate: '2026-09-24', endDate: '2026-09-30', day: 1, total: 7, touchesDone: 1, touchesPlanned: 1, cold: true },
  { id: 'b', name: 'Older', podName: "Andrew's pod", products: [], paused: true, startDate: '2026-09-01', endDate: null, day: 24, total: null, touchesDone: 3, touchesPlanned: 9 },
  { id: 'c', name: 'Tomorrow', podName: "Andrew's pod", products: ['GLYNAC', 'PHH'], paused: false, startDate: '2026-09-25', endDate: '2026-10-25', day: 0, total: 31, touchesDone: 0, touchesPlanned: 4 },
];
const base: ReportDocumentProps = { reports: report(2), previous: report(1), range: { from: '2026-09-01', to: '2026-09-24' }, compared: { from: '2026-08-01', to: '2026-08-24' }, scope: 'All pods', campaigns, generatedBy: 'Admin', generatedAt: new Date('2026-09-24T12:00:00Z') };
// Up, down and unchanged figures; no earlier period; an empty period with no campaigns.
const variants: ReportDocumentProps[] = [base, { ...base, reports: report(1), previous: report(2) }, { ...base, previous: report(2), reports: report(2) }, { ...base, previous: null, compared: null }, { ...base, reports: report(0), previous: report(0), campaigns: [] }, { ...base, reports: report(2, 'cold'), previous: report(1, 'cold') }, { ...base, reports: report(2, 'crm'), previous: report(1, 'crm') }];

// Reports > Calls, as the export renders it: All outreach with every part, and an empty CRM view.
const totals = (n: number) => ({ dials: 4 * n, inbound: n, connects: 2 * n, connectRate: n ? 0.5 : 0, inboundAnswered: n, conversations: n, talkSec: 300 * n, avgTalkPerConnect: 150, meetings: n, avgRating: n ? 4 : null, formsOutstanding: n, medianMinutesToForm: n ? 12 : null, costUsd: n, calledOptedOut: n, longVoicemails: n });
const call = (id: string, cold: boolean) => ({ id, startedAt: new Date('2026-09-23T15:00:00Z'), createdAt: new Date('2026-09-23T15:00:00Z'), direction: 'OUTBOUND', status: 'COMPLETED', toNumber: '+15550000000', fromNumber: '+15551111111', talkSec: 95, audience: cold ? 'SANDBOX' : 'CRM', formDueAt: null, formDoneAt: null, user: { id: 'u', name: 'Alyssa' }, form: { outcome: 'connected', rating: 4, flags: ['called_opted_out'] }, subject: { firstName: 'Jane', lastName: 'Doe', companyName: 'Acme', href: '/people/p' } });
const calls = (n: number, audience: 'all' | 'crm'): CallReport => ({ audience, totals: totals(n), previous: n ? totals(0) : null, split: { crm: totals(n), cold: totals(n), unmatched: totals(n), all: totals(3 * n) }, byRep: n ? [{ userId: 'u', name: 'Alyssa', ...totals(n), oldestFormDue: new Date('2026-09-22T10:00:00Z') }] : [], byOutcome: n ? [{ key: 'connected', label: 'Connected', count: n }] : [], bestHours: n ? [{ slot: 'Tue 10', dials: 4, connects: 2, rate: 0.5 }] : [], calls: n ? [call('c1', true), call('c2', false)] : [], callsTotal: n ? 120 : 0, page: 1, pages: n ? 3 : 1, unmatched: n ? [{ ...call('u1', false), user: null, subject: null }] : [], unmatchedTotal: n ? 60 : 0, unmatchedPage: 1, unmatchedPages: n ? 2 : 1, outcomes: [{ key: 'connected', label: 'Connected', answered: true, badPhone: false }] }) as unknown as CallReport;
const callVariants: CallsDocumentProps[] = [{ data: calls(2, 'all'), timezone: 'America/Chicago', compared: { from: '2026-08-01', to: '2026-08-24' }, links: { call: (id) => `/calls/${id}`, page: () => '/reports' } }, { data: calls(0, 'crm'), timezone: 'America/Chicago', compared: null }];

/** Tailwind's class name as it appears in a stylesheet selector. */
const escape = (cls: string) => cls.replace(/[[\](),.:/%#!']/g, (c) => `\\${c}`);
const ruleFor = (cls: string) => new RegExp(`\\.${escape(cls).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,{:>])`);
// Classes that only group or mark elements, styled through a parent rule.
const STRUCTURAL = new Set<string>();

describe('the exported report', () => {
  const html = [...variants.map((props) => renderToStaticMarkup(createElement(ReportDocument, props))), ...callVariants.map((props) => renderToStaticMarkup(createElement(CallsDocument, props)))];
  const used = new Set(html.flatMap((page) => [...page.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean))));

  it('has its own style rule for every class the document uses, in every state', () => {
    expect([...used].filter((cls) => !STRUCTURAL.has(cls) && !ruleFor(cls).test(REPORT_EXPORT_STYLES))).toEqual([]);
  });

  it('carries no rule for a class the document no longer uses', () => {
    // Only the selector side of each rule: values such as 1.5 or -0.02em are not class names.
    const heads = REPORT_EXPORT_STYLES.split('}').map((rule) => rule.split('{').at(-2) ?? '');
    const selectors = heads.flatMap((head) => [...head.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, '$1')));
    // Base classes the table and surfaces are built on, written as element rules under them.
    const always = new Set<string>();
    expect([...new Set(selectors)].filter((cls) => !used.has(cls) && !always.has(cls))).toEqual([]);
  });
});
