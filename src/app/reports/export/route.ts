import { NextResponse } from 'next/server';
import { prerender } from 'react-dom/static';
import { createElement } from 'react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { canViewReports, toActor } from '@/lib/auth/rbac';
import { loadReportBundle } from '@/lib/reports-bundle';
import { ReportDocument } from '@/components/reports/report-document';

export const dynamic = 'force-dynamic';

/**
 * The report as one file: the same document the Reports page shows, with its styles inside, no
 * scripts, so it opens anywhere, prints to PDF and can be sent on. Same roles as Reports.
 */
const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #f5f6f4; color: #1f2a26; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  h1 { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 4px; }
  .surface { background: #fff; border: 1px solid #e3e8e2; border-radius: 14px; }
  .space-y-5 > * + * { margin-top: 20px; } .space-y-3 > * + * { margin-top: 12px; } .space-y-2 > * + * { margin-top: 8px; } .space-y-2\\.5 > * + * { margin-top: 10px; }
  .grid { display: grid; } .gap-3 { gap: 12px; } .gap-4 { gap: 16px; } .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  @media (min-width: 640px) { .sm\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 768px) { .md\\:grid-cols-\\[minmax\\(0\\,14rem\\)_1fr_minmax\\(0\\,12rem\\)\\] { grid-template-columns: minmax(0, 14rem) 1fr minmax(0, 12rem); } .md\\:items-center { align-items: center; } .md\\:gap-4 { gap: 16px; } .md\\:text-right { text-align: right; } }
  @media (min-width: 900px) { .xl\\:grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); } .xl\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .xl\\:grid-cols-\\[minmax\\(0\\,3fr\\)_minmax\\(0\\,2fr\\)\\] { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } }
  .grid-cols-\\[minmax\\(0\\,10rem\\)_minmax\\(0\\,1fr\\)_3\\.5rem\\] { grid-template-columns: minmax(0, 10rem) minmax(0, 1fr) 3.5rem; } .grid-cols-\\[minmax\\(0\\,9rem\\)_minmax\\(0\\,1fr\\)_6rem\\] { grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 6rem; } .grid-cols-\\[minmax\\(0\\,14rem\\)_1fr_minmax\\(0\\,12rem\\)\\] { grid-template-columns: minmax(0, 14rem) 1fr minmax(0, 12rem); }
  .flex { display: flex; } .inline-flex { display: inline-flex; } .inline-block { display: inline-block; } .items-center { align-items: center; } .items-start { align-items: flex-start; } .items-baseline { align-items: baseline; } .justify-between { justify-content: space-between; } .flex-wrap { flex-wrap: wrap; } .gap-1 { gap: 4px; } .gap-1\\.5 { gap: 6px; } .gap-2 { gap: 8px; } .gap-3 { gap: 12px; } .gap-4 { gap: 16px; }
  .px-5 { padding-left: 20px; padding-right: 20px; } .py-5 { padding-top: 20px; padding-bottom: 20px; } .p-5 { padding: 20px; } .p-\\[1px\\] { padding: 1px; } .pr-3 { padding-right: 12px; } .pb-1 { padding-bottom: 4px; }
  .mt-1 { margin-top: 4px; } .mt-1\\.5 { margin-top: 6px; } .mt-2 { margin-top: 8px; } .mt-3 { margin-top: 12px; } .mb-4 { margin-bottom: 16px; } .ml-1 { margin-left: 4px; } .ml-2 { margin-left: 8px; } .mr-1 { margin-right: 4px; }
  .min-w-0 { min-width: 0; } .w-full { width: 100%; } .w-10 { width: 40px; } .h-8 { height: 32px; } .h-1\\.5 { height: 6px; } .h-2\\.5 { height: 10px; } .w-2\\.5 { width: 10px; } .h-full { height: 100%; }
  .rounded-full { border-radius: 999px; } .rounded-md { border-radius: 6px; } .rounded-sm { border-radius: 2px; } .overflow-hidden { overflow: hidden; } .overflow-x-auto { overflow-x: auto; } .overflow-visible { overflow: visible; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .whitespace-nowrap { white-space: nowrap; } .text-right { text-align: right; } .text-center { text-align: center; } .text-left { text-align: left; }
  .tabular-nums { font-variant-numeric: tabular-nums; } .font-medium { font-weight: 500; } .font-semibold { font-weight: 600; } .leading-tight { line-height: 1.15; } .tracking-\\[-0\\.04em\\] { letter-spacing: -0.04em; }
  .text-\\[11px\\] { font-size: 11px; } .text-\\[11\\.5px\\] { font-size: 11.5px; } .text-\\[12px\\] { font-size: 12px; } .text-\\[12\\.5px\\] { font-size: 12.5px; } .text-\\[13px\\] { font-size: 13px; } .text-\\[30px\\] { font-size: 30px; }
  .text-ink-900 { color: #1f2a26; } .text-ink-800 { color: #2b3a34; } .text-ink-700 { color: #3c4a44; } .text-ink-600 { color: #55645d; } .text-ink-500 { color: #6b7a74; } .text-ink-400 { color: #98a59f; } .text-emerald-700 { color: #047857; } .text-amber-700 { color: #b45309; }
  .table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; } .table th { border-top: 1px solid #e3e8e2; border-bottom: 1px solid #e3e8e2; background: #f8faf9; padding: 8px 12px; font-size: 11.5px; font-weight: 500; color: #55645d; white-space: nowrap; } .table td { border-bottom: 1px solid rgba(227,232,226,.7); padding: 10px 12px; vertical-align: middle; } .table .num { text-align: right; font-variant-numeric: tabular-nums; }
  figure { margin: 0; } figcaption { display: flex; justify-content: space-between; margin-bottom: 16px; }
  @media print { body { padding: 0; background: #fff; } .surface { break-inside: avoid; } }
`;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse('Sign in to export a report.', { status: 401 });
  if (!canViewReports(toActor(user))) return new NextResponse('Reports are not available to this role.', { status: 403 });
  const url = new URL(request.url);
  const sp = { from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined, pod: url.searchParams.get('pod') ?? undefined, fo: url.searchParams.get('fo') ?? undefined };
  const bundle = await loadReportBundle(user, sp);
  // Static markup, no client runtime: the document is server-only, so nothing needs hydrating.
  const { prelude } = await prerender(
    createElement(ReportDocument, { reports: bundle.reports, previous: bundle.previous, range: { from: bundle.range.from, to: bundle.range.to }, scope: bundle.scope, campaigns: bundle.campaigns, generatedBy: user.name, generatedAt: new Date() }),
  );
  const body = await new Response(prelude).text();
  const title = `Cadence report ${bundle.range.from} to ${bundle.range.to}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLES}</style></head><body><h1>${title}</h1><div class="space-y-5">${body}</div></body></html>`;
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `inline; filename="cadence-report-${bundle.range.from}-to-${bundle.range.to}.html"`, 'cache-control': 'no-store' } });
}
