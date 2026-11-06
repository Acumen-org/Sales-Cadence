import Link from 'next/link';
import { PageFrame } from '@/components/page-frame';
import { requireUser } from '@/lib/auth/current-user';
import { formatInstant } from '@/lib/dates';
import { listPushes } from '@/lib/sandbox/pushes-query';
import { COLD_FROM_BELLWETHER_HREF } from '@/lib/subject';
import { ColdOutreachHeader, seesPushes } from '@/components/sandbox/section-tabs';
import { Badge, EmptyState, Notice, Surface } from '@/components/ui';

export const metadata = { title: 'From Bellwether · Cold outreach' };

/**
 * Cold outreach > From Bellwether (PLAN 4.8, B057): one row per push with what it added, merged,
 * found in the CRM, refused and left unclaimed; each opens to the result and reason for every contact.
 */
export default async function FromBellwetherPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  if (!seesPushes(user)) {
    return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
      <ColdOutreachHeader user={user} current="contacts" />
      <Notice tone="info">From Bellwether is for Sales Leaders, Pod Managers, Biz Ops and admins. Ask your pod leader what happened to a push.</Notice>
    </PageFrame>;
  }
  const { rows, total, pages, page } = await listPushes(Number(sp.page ?? 1) || 1);
  const pageHref = (n: number) => `${COLD_FROM_BELLWETHER_HREF}?page=${n}`;
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <ColdOutreachHeader user={user} current="bellwether" />
    <Surface flush>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3 text-[13px]"><span className="text-ink-600">Every push from Bellwether, newest first. Open one to see what happened to each contact and why.</span><span className="tabular-nums text-ink-500">{total === 1 ? '1 push' : `${total} pushes`}</span></div>
      {rows.length ? <ul className="divide-y divide-line">{rows.map((p) => <li key={p.id}>
        <details className="group">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3 text-[13px] hover:bg-canvas/60">
            <span aria-hidden className="text-ink-400 transition-transform group-open:rotate-90">›</span>
            <span className="w-40 shrink-0 tabular-nums text-ink-700">{formatInstant(p.at, user.timezone)}</span>
            <span className="min-w-0 flex-1 text-ink-900">{p.by}{p.owner ? <span className="text-ink-500"> · for {p.owner}</span> : null}<span className="text-ink-500"> · {p.count === 1 ? '1 contact' : `${p.count} contacts`}</span></span>
            <span className="flex flex-wrap gap-1.5">
              {p.state !== 'DONE' ? <Badge tone={p.state === 'FAILED' ? 'red' : 'blue'}>{p.state === 'FAILED' ? 'Failed: Bellwether may send it again' : 'Still being read'}</Badge> : null}
              {p.added ? <Badge tone="green">{`${p.added} added`}</Badge> : null}
              {p.unclaimed ? <Badge tone="amber">{`${p.unclaimed} unclaimed`}</Badge> : null}
              {p.merged ? <Badge tone="blue">{`${p.merged} already here`}</Badge> : null}
              {p.inCrm ? <Badge tone="sky">{`${p.inCrm} already in CRM`}</Badge> : null}
              {p.refused ? <Badge tone="red">{`${p.refused} refused`}</Badge> : null}
            </span>
          </summary>
          {p.contacts.length ? <div className="overflow-x-auto border-t border-line bg-canvas/40"><table className="w-full text-[13px]"><thead><tr className="text-left text-ink-500"><th className="px-5 py-2 font-normal">Contact</th><th className="px-4 py-2 font-normal">Result</th><th className="px-4 py-2 font-normal">Why</th></tr></thead>
            <tbody className="divide-y divide-line">{p.contacts.map((c) => <tr key={c.key} className="align-top">
              <td className="px-5 py-2">{c.href ? <Link href={c.href} className="text-ink-900 hover:text-brand-700">{c.name}</Link> : <span className="text-ink-700">{c.name}</span>}</td>
              <td className="px-4 py-2"><Badge tone={c.tone}>{c.result}</Badge></td>
              <td className="px-4 py-2 text-ink-600">{c.why ?? '-'}</td>
            </tr>)}</tbody></table></div> : <p className="border-t border-line px-5 py-3 text-[13px] text-ink-500">This push has no contact results kept.</p>}
        </details>
      </li>)}</ul> : <EmptyState title="No pushes from Bellwether yet" hint="When a rep sends contacts from Bellwether, each push shows here with what became of every contact." />}
      {pages > 1 ? <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-[13px]">{page > 1 ? <Link href={pageHref(page - 1)} className="btn-ghost btn-sm">Previous</Link> : null}<span className="tabular-nums text-ink-500">{page} of {pages}</span>{page < pages ? <Link href={pageHref(page + 1)} className="btn-ghost btn-sm">Next</Link> : null}</div> : null}
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
