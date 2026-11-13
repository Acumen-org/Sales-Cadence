'use client';

import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { assignFollowUpAction } from '@/lib/actions/linkedin';

export type NeedsOwnerRow = { id: string; name: string; href: string | null; why: string; account: string | null; company: string | null; podIds: string[] };

/**
 * "Needs an owner" (owner, 12 and 13 Nov 2026), in Cold outreach: a cold contact with no owner answered -
 * accepted our LinkedIn request, wrote back on LinkedIn, or answered an email. Anyone in the pod can take
 * them; a pod leader or an admin can give them to someone. Their task is due 2 working days after that.
 */
export function LinkedInNeedsOwner({ rows, owners, canTake }: { rows: NeedsOwnerRow[]; owners: { id: string; name: string; podIds: string[] }[]; canTake: boolean }) {
  if (!rows.length) return null;
  return <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4" aria-labelledby="li-needs-owner">
    <h2 id="li-needs-owner" className="text-[14px] font-semibold text-ink-900">They answered: needs an owner <span className="tabular-nums text-ink-500">· {rows.length}</span></h2>
    <p className="mt-0.5 text-[12.5px] text-ink-600">They answered us and nobody owns them yet. Whoever takes them gets a task to answer within 2 working days.</p>
    <ul className="mt-3 divide-y divide-amber-200/70">{rows.map((r) => {
      const fit = owners.filter((o) => !r.podIds.length || o.podIds.some((p) => r.podIds.includes(p)));
      return <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-ink-900">{r.href ? <Link href={r.href} className="hover:text-brand-700">{r.name}</Link> : r.name}{r.company ? <span className="font-normal text-ink-500"> · {r.company}</span> : null}</span>
          <span className="block text-[12px] text-ink-600">{r.why}{r.account ? <> · {r.account}&apos;s LinkedIn</> : null}</span>
        </span>
        {canTake ? <ActionForm action={assignFollowUpAction} className="flex items-center gap-1.5"><input type="hidden" name="id" value={r.id} /><button type="submit" className="btn-secondary btn-sm">Take it</button></ActionForm> : null}
        {fit.length ? <ActionForm action={assignFollowUpAction} className="flex items-center gap-1.5">
          <input type="hidden" name="id" value={r.id} />
          <select name="foUserId" required aria-label={`Give ${r.name} to`} className="!py-0.5 text-[12px]" defaultValue=""><option value="" disabled>Give to</option>{fit.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <button type="submit" className="btn-secondary btn-sm">Give</button>
        </ActionForm> : null}
      </li>;
    })}</ul>
  </section>;
}
