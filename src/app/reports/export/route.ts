import { NextResponse } from 'next/server';
import { prerender } from 'react-dom/static';
import { createElement } from 'react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { canViewReports, toActor } from '@/lib/auth/rbac';
import { loadReportBundle } from '@/lib/reports-bundle';
import { ReportDocument } from '@/components/reports/report-document';
import { REPORT_EXPORT_STYLES as STYLES } from '@/lib/report-export-styles';

export const dynamic = 'force-dynamic';

/**
 * The report as one file: the same document the Reports page shows, with its styles inside, no
 * scripts, so it opens anywhere, prints to PDF and can be sent on. Same roles as Reports.
 */

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse('Sign in to export a report.', { status: 401 });
  if (!canViewReports(toActor(user))) return new NextResponse('Reports are not available to this role.', { status: 403 });
  const url = new URL(request.url);
  const sp = { from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined, pod: url.searchParams.get('pod') ?? undefined, fo: url.searchParams.get('fo') ?? undefined };
  const bundle = await loadReportBundle(user, sp);
  // Static markup, no client runtime: the document is server-only, so nothing needs hydrating.
  const { prelude } = await prerender(
    createElement(ReportDocument, { reports: bundle.reports, previous: bundle.previous, range: { from: bundle.range.from, to: bundle.range.to }, compared: bundle.previousRange, scope: bundle.scope, campaigns: bundle.campaigns, generatedBy: user.name, generatedAt: new Date() }),
  );
  const body = await new Response(prelude).text();
  const title = `Cadence report ${bundle.range.from} to ${bundle.range.to}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLES}</style></head><body><h1>${title}</h1><div class="space-y-5">${body}</div></body></html>`;
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `inline; filename="cadence-report-${bundle.range.from}-to-${bundle.range.to}.html"`, 'cache-control': 'no-store' } });
}
