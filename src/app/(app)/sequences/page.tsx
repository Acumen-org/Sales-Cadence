import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canEditSequences } from '@/lib/auth/rbac';
import { listSequences } from '@/lib/sequences-query';
import { ACTION_LABELS, type ActionType } from '@/lib/sequences/steps';
import { ActionIcon, IconPlus, IconSequences } from '@/components/icons';
import { Badge, EmptyState } from '@/components/ui';

export default async function SequencesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const user = await requireUser(); const all = await listSequences(); const { q = '', status = 'active' } = await searchParams;
  const sequences = all.filter(s => s.name.toLowerCase().includes(q.toLowerCase()) && (status === 'archived' ? s.archived : !s.archived));
  return <div className="space-y-5 px-6 pb-8 pt-2">
    <div className="flex flex-wrap items-center gap-3"><div className="flex gap-1 rounded-lg border border-line bg-white p-1">{[['active', 'Available'], ['archived', 'Archived']].map(([key, label]) => <Link key={key} href={'/sequences?status=' + key + '&q=' + encodeURIComponent(q)} className={status === key ? 'chip' : 'chip-muted'}>{label}</Link>)}</div><form className="ml-auto" role="search"><input type="hidden" name="status" value={status} /><input name="q" defaultValue={q} aria-label="Search sequences" placeholder="Find a sequence" /></form>{canEditSequences(user) && <Link href="/sequences/new" className="btn-primary"><IconPlus size={15} />New sequence</Link>}</div>
    {!sequences.length && <div className="surface"><EmptyState title="No sequences found" icon={<IconSequences size={22} />} /></div>}
    {sequences.map(s => <Link key={s.id} href={'/sequences/' + s.id} className="surface group block overflow-hidden p-6 transition hover:border-brand-300 hover:shadow-md">
      <div className="mb-6 flex flex-wrap items-center gap-3"><span className="rounded-xl bg-brand-50 p-3 text-brand-700"><IconSequences size={22} /></span><h2 className="text-xl font-semibold tracking-tight group-hover:text-brand-700">{s.name}</h2><Badge tone="green" className="ml-auto"><strong>{s.campaigns}</strong> {s.campaigns === 1 ? 'campaign' : 'campaigns'}</Badge></div>
      <div className="flex flex-wrap items-center gap-y-4">{s.preview.map((step, i) => <div key={step.id} className="flex items-center">{i > 0 && <span className="mx-2 h-px w-5 bg-brand-200" />}<div className="min-w-32 rounded-xl border border-line bg-canvas/60 p-3"><div className="mb-2 text-xs text-ink-500">Business day <strong className="text-ink-900">{step.day}</strong></div><div className="space-y-2">{step.actions.map((a, j) => <span key={j} className="flex items-center gap-2 text-xs font-semibold text-ink-900"><ActionIcon action={a} size={14} />{ACTION_LABELS[a as ActionType]}</span>)}</div></div></div>)}</div>
    </Link>)}
  </div>;
}
