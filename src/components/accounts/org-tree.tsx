import Link from 'next/link';
import { Avatar, Badge, type BadgeTone } from '@/components/ui';

export type TreePerson = {
  id: string;
  name: string;
  jobTitle: string | null;
  dnd: boolean;
  optedOut: boolean;
  enrollment: { status: string; label: string; tone: BadgeTone; foName: string; stepIndex: number; steps: number } | null;
  lastTouch: string | null;
  touches: number;
};
/** Title bands describe known titles, without claiming a reporting relationship. */
export function OrgTree({ everyone }: { everyone: TreePerson[] }) {
  const bands = [
    { label: 'Executive titles', match: /\b(chief|ceo|cfo|cio|cto|coo|cmo|president|founder|owner|partner)\b/i },
    { label: 'Leadership titles', match: /\b(vp|vice president|director|head)\b/i },
    { label: 'Management titles', match: /\b(manager|lead)\b/i },
    { label: 'Other titles', match: /\S/ },
    { label: 'Title missing', match: /^$/ },
  ];
  const grouped = bands.map((band, index) => ({
    ...band,
    people: everyone.filter((person) => bands.findIndex((b) => b.match.test(person.jobTitle?.trim() ?? '')) === index)
      .sort((a, b) => (a.jobTitle ?? '').localeCompare(b.jobTitle ?? '') || a.name.localeCompare(b.name)),
  })).filter((band) => band.people.length);

  return <div className="space-y-7">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-base font-semibold text-ink-900">People by position</h3><Badge tone="gray">Grouped from CRM job titles</Badge></div>
    {grouped.map((band) => <section key={band.label} className="space-y-3">
      <div className="flex items-center gap-3"><h4 className="text-sm font-medium text-ink-500">{band.label}</h4><strong className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-800">{band.people.length}</strong><div className="h-px flex-1 bg-line" /></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{band.people.map((p) => <article key={p.id} className="rounded-xl border border-line bg-white p-4 shadow-surface">
        <div className="flex items-start gap-3"><Avatar name={p.name} shape="circle" size={36} /><div className="min-w-0"><Link href={`/people/${p.id}`} className="font-semibold text-ink-900 hover:text-brand-700 hover:underline">{p.name}</Link><div className="mt-1 text-sm font-semibold text-ink-700">{p.jobTitle ?? 'Title missing'}</div></div></div>
        <div className="mt-4 flex flex-wrap gap-2">{p.enrollment ? <Badge tone={p.enrollment.tone}>{p.enrollment.label}</Badge> : null}{p.dnd || p.optedOut ? <Badge tone="red">Do not contact</Badge> : null}</div>
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs"><div><dt className="text-ink-500">Touches</dt><dd className="mt-1 font-bold text-ink-900">{p.touches}</dd></div><div><dt className="text-ink-500">Last touch</dt><dd className="mt-1 font-semibold text-ink-900">{p.lastTouch ?? 'No activity'}</dd></div>{p.enrollment ? <div className="col-span-2"><dt className="text-ink-500">Assigned to</dt><dd className="mt-1 font-semibold text-ink-900">{p.enrollment.foName}</dd></div> : null}</dl>
      </article>)}</div>
    </section>)}
  </div>;
}
