import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { ACTIVITY_KINDS, activityByUser, KIND_LABELS, listActivity, type ActivityKind } from '@/lib/activity-query';
import { formatInstant, formatLocalDate, toLocalDate, todayIn } from '@/lib/dates';
import { ActivityToolbar } from '@/components/activity/activity-toolbar';
import { ActionIcon } from '@/components/icons';
import { Avatar, Badge, EmptyState, Surface, Toolbar, ViewHeader } from '@/components/ui';

type Search = { actor?: string; kind?: string; q?: string; before?: string };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const kinds = (sp.kind ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k): k is ActivityKind => (ACTIVITY_KINDS as readonly string[]).includes(k));
  // Passed through verbatim: the cursor is "<instant>|<last item id>".
  const before = sp.before?.trim() || null;
  const q = (sp.q ?? '').trim() || null;
  const actorId = sp.actor || null;

  const [page, users, byUser] = await Promise.all([
    listActivity({ before, actorId, kinds: kinds.length ? kinds : null, q, limit: 60 }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    activityByUser(new Date(Date.now() - 7 * 86_400_000)),
  ]);

  const today = todayIn(user.timezone);
  // Group by local day so the feed reads as a diary.
  const groups: Array<{ day: string; items: typeof page.items }> = [];
  for (const item of page.items) {
    const day = toLocalDate(item.at, user.timezone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }

  const nextHref = () => {
    const p = new URLSearchParams();
    if (actorId) p.set('actor', actorId);
    if (kinds.length) p.set('kind', kinds.join(','));
    if (q) p.set('q', q);
    if (page.nextCursor) p.set('before', page.nextCursor);
    return `/activity?${p.toString()}`;
  };

  return (
    <div className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title="Activity" caret meta={`${page.items.length} event${page.items.length === 1 ? '' : 's'}${page.hasMore ? '+' : ''}`} />
        <Toolbar>
          <ActivityToolbar users={users} actorId={actorId} kinds={kinds} q={q ?? ''} />
        </Toolbar>

        {byUser.length ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Last 7 days</span>
            {byUser.slice(0, 8).map((u) => (
              <Link key={u.id} href={`/activity?actor=${u.id}`} className={actorId === u.id ? 'chip' : 'chip-muted'}>
                <Avatar name={u.name} shape="circle" size={16} />
                {u.name.split(/\s+/)[0]}
                <span className="opacity-60">{u.touches + u.tasks}</span>
              </Link>
            ))}
          </div>
        ) : null}

        {page.items.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            hint={q || actorId || kinds.length ? 'No activity matches these filters.' : 'Emails, calls, tasks, sequence changes and meetings appear here as they happen. Administration is left out.'}
          />
        ) : (
          <div>
            {groups.map((g) => (
              <section key={g.day}>
                <h2 className="sticky top-0 z-10 border-y border-line bg-canvas/95 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500 backdrop-blur">
                  {g.day === today ? 'Today' : formatLocalDate(g.day, 'long')}
                  <span className="ml-2 font-normal normal-case tracking-normal text-ink-400">{g.items.length} events</span>
                </h2>
                <ol className="divide-y divide-line">
                  {g.items.map((it) => (
                    <li key={it.id} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
                      <span className="mt-0.5 w-[46px] shrink-0 font-mono text-[11px] text-ink-400">{formatInstant(it.at, user.timezone).split(', ').pop()}</span>
                      <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : it.tone === 'out' ? 'mt-0.5 text-ink-500' : 'mt-0.5 text-ink-300'}>
                        {it.icon === 'MEETING' || it.icon === 'STATE' ? <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" /> : <ActionIcon action={it.icon} size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-ink-800">
                          {it.actorName ? <span className="font-medium text-ink-900">{it.actorName}</span> : <span className="font-medium text-ink-500">System</span>}{' '}
                          {it.title}
                          {it.subjectName ? (
                            <>
                              {' · '}
                              {it.subjectHref ? (
                                <Link href={it.subjectHref} className="text-brand-700 hover:underline">
                                  {it.subjectName}
                                </Link>
                              ) : (
                                it.subjectName
                              )}
                            </>
                          ) : null}
                        </span>
                        <span className="block truncate text-[11.5px] text-ink-400">{[it.companyName, it.detail].filter(Boolean).join(' · ')}</span>
                      </span>
                      <Badge tone="gray" className="shrink-0">
                        {KIND_LABELS[it.kind]}
                      </Badge>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </Surface>

      {page.hasMore ? (
        <div className="flex justify-center">
          <Link href={nextHref()} className="btn-secondary">
            Load older activity
          </Link>
        </div>
      ) : null}
      {before ? (
        <div className="flex justify-center">
          <Link href="/activity" className="btn-ghost btn-sm">
            Back to the latest
          </Link>
        </div>
      ) : null}
    </div>
  );
}
