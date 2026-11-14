import { NextResponse } from 'next/server';
import { prerender } from 'react-dom/static';
import { createElement } from 'react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { canViewReports, toActor } from '@/lib/auth/rbac';
import { loadReportBundle } from '@/lib/reports-bundle';
import { ReportDocument } from '@/components/reports/report-document';
import { CallsDocument } from '@/components/reports/calls-report';
import { callReport } from '@/lib/calls/analytics';
import { REPORT_AUDIENCES, reportingTimezone } from '@/lib/reports-query';
import { REPORT_EXPORT_STYLES as STYLES } from '@/lib/report-export-styles';
import { workspaceTimezone } from '@/lib/workspace';
import { addDays, formatLocalDate, startOfLocalDay } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/**
 * The report as one file: the same document the Reports page shows, for the same audience and view
 * (B125: All outreach, CRM or Cold outreach; Outreach or Calls), with its styles inside, no scripts,
 * so it opens anywhere, prints to PDF and can be sent on. Same roles as Reports.
 */

export async function GET(request: Request) {
  const user = await getCurrentUser();
  const url = new URL(request.url);
  // R22: an ended session goes to sign-in and back to the same Reports view, never a bare line of text.
  if (!user) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(`/reports${url.search}`)}`, url), 303);
  if (!canViewReports(toActor(user))) return new NextResponse('Reports are not available to this role.', { status: 403 });
  const get = (k: string) => url.searchParams.get(k) ?? undefined;
  const sp = { from: get('from'), to: get('to'), pod: get('pod'), fo: get('fo'), audience: get('audience') };
  const calls = get('view') === 'calls';
  const bundle = await loadReportBundle(user, sp);
  const tz = reportingTimezone();
  const instant = (d: string) => startOfLocalDay(d, tz);
  // Static markup, no client runtime: the document is server-only, so nothing needs hydrating.
  const { prelude } = await prerender(calls
    ? createElement(CallsDocument, {
      data: await callReport({ from: instant(bundle.range.from), to: instant(addDays(bundle.range.to, 1)), podId: bundle.podId, foUserId: bundle.foUserId, audience: bundle.audience, allRows: true, previous: { from: instant(bundle.previousRange.from), to: instant(addDays(bundle.previousRange.to, 1)) } }),
      timezone: workspaceTimezone(), compared: bundle.previousRange,
    })
    : createElement(ReportDocument, { reports: bundle.reports, previous: bundle.previous, range: { from: bundle.range.from, to: bundle.range.to }, compared: bundle.previousRange, scope: bundle.scope, campaigns: bundle.campaigns, generatedBy: user.name, generatedAt: new Date(), timezone: workspaceTimezone() }),
  );
  const body = await new Response(prelude).text();
  const audience = REPORT_AUDIENCES.find((a) => a.key === bundle.audience)!.label;
  const title = `Cadence ${calls ? 'calls report' : 'report'}, ${audience}, ${formatLocalDate(bundle.range.from, 'year')} to ${formatLocalDate(bundle.range.to, 'year')}`;
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const sub = calls ? `<p>${esc(bundle.scope)}</p>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLES}</style></head><body><h1>${title}</h1>${sub}${body}</body></html>`;
  const file = `cadence-${calls ? 'calls' : 'report'}-${bundle.audience === 'all' ? 'all-outreach' : bundle.audience === 'crm' ? 'crm' : 'cold-outreach'}-${bundle.range.from}-to-${bundle.range.to}.html`;
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `inline; filename="${file}"`, 'cache-control': 'no-store' } });
}
