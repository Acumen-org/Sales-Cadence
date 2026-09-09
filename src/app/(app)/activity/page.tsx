import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isJuniorFo, visiblePodIds } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { ACTIVITY_KINDS, KIND_LABELS, listActivity, type ActivityKind } from '@/lib/activity-query';
import { formatInstant, formatLocalDate, toLocalDate, todayIn } from '@/lib/dates';
import { reportingRange, REPORTING_TIMEZONE } from '@/lib/reports-query';
import { ActivityToolbar } from '@/components/activity/activity-toolbar';
import { ActionIcon } from '@/components/icons';
import { Badge, DataValue, EmptyState, EventDetail, Notice, Surface, Toolbar, ViewHeader } from '@/components/ui';

type Search = { actor?: string; pod?: string; channel?: string; kind?: string; q?: string; before?: string; from?: string; to?: string };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const kinds = (sp.kind ?? '').split(',').map((kind) => kind.trim()).filter((kind): kind is ActivityKind => (ACTIVITY_KINDS as readonly string[]).includes(kind));
  const channel = ['EMAIL', 'CALL', 'LINKEDIN'].includes(sp.channel ?? '') ? sp.channel as 'EMAIL' | 'CALL' | 'LINKEDIN' : null;
  const before = sp.before?.trim() || null;
  const q = (sp.q ?? '').trim().slice(0, 200);
  const actorId = sp.actor || null;
  const podId = sp.pod || null;
  const today = todayIn(REPORTING_TIMEZONE);
  const range = reportingRange(sp.from, sp.to, today, 7);
  const visiblePods = visiblePodIds(user);
  const [page, users, pods] = await Promise.all([
    listActivity({ before, actorId, podId, channel, kinds: kinds.length ? kinds : null, q, from: range.fromInstant, to: range.toInstant, viewer: user, limit: 60 }),
    prisma.user.findMany({
      where: isJuniorFo(user) ? { id: user.id } : visiblePods === null ? {} : { OR: [{ id: user.id }, { pods: { some: { podId: { in: visiblePods } } } }] },
      select: { id: true, name: true, pods: { select: { podId: true } } }, orderBy: { name: 'asc' },
    }),
    prisma.pod.findMany({ where: visiblePods === null ? {} : { id: { in: visiblePods } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const groups: Array<{ day: string; items: typeof page.items }> = [];
  for (const item of page.items) {
    const day = toLocalDate(item.at, REPORTING_TIMEZONE);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  const pageHref = (cursor?: string | null) => {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (actorId) params.set('actor', actorId);
    if (podId) params.set('pod', podId);
    if (channel) params.set('channel', channel);
    if (kinds.length) params.set('kind', kinds.join(','));
    if (q) params.set('q', q);
    if (cursor) params.set('before', cursor);
    return `/activity?${params.toString()}`;
  };
  return (
    <div className="space-y-4 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title="Workspace timeline" meta={<><strong>{page.items.length}{page.hasMore ? '+' : ''}</strong> <span className="font-normal text-ink-500">events</span></>} />
        <Toolbar><ActivityToolbar key={`${podId}:${actorId}:${range.from}:${range.to}:${channel}:${kinds.join(',')}:${q}`} users={users.map((item) => ({ id: item.id, name: item.name, podIds: item.pods.map((pod) => pod.podId) }))} pods={pods} actorId={actorId} podId={podId} channel={channel} kinds={kinds} q={q} from={range.from} to={range.to} /></Toolbar>
        {range.error ? <div className="px-4 pb-4"><Notice tone="error">{range.error}</Notice></div> : null}
        {page.items.length === 0 ? <EmptyState title="No activity in this view" action={<Link href="/activity" className="btn-secondary">Reset filters</Link>} /> : (
          <div>{groups.map((group) => (
            <section key={group.day}>
              <h2 className="flex flex-wrap items-center justify-between gap-2 border-y border-line bg-canvas/80 px-5 py-3">
                <DataValue className="!text-[14px]">{group.day === today ? 'Today' : formatLocalDate(group.day, 'long')}</DataValue>
                <span className="text-[12px] text-ink-500"><DataValue>{group.items.length}</DataValue> events</span>
              </h2>
              <ol className="divide-y divide-line">{group.items.map((item) => (
                <li key={item.id} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-5 py-4 sm:grid-cols-[3rem_2rem_minmax(0,1fr)_auto]">
                  <time dateTime={item.at.toISOString()} className="col-span-2 text-[13px] font-bold tabular-nums text-ink-900 sm:col-span-1 sm:pt-1">{formatInstant(item.at, REPORTING_TIMEZONE).split(', ').pop()}</time>
                  <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${item.tone === 'in' ? 'bg-emerald-50 text-emerald-700' : 'bg-brand-50 text-brand-700'}`}>
                    {item.icon === 'MEETING' || item.icon === 'STATE' ? <span className="h-3 w-3 rounded-full border-2 border-current" /> : <ActionIcon action={item.icon} size={17} />}
                  </span>
                  <div className="min-w-0 space-y-2">
                    <p className="break-words text-[14px] font-semibold text-ink-900">{item.title}</p>
                    {item.subjectName ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{item.subjectHref ? <Link href={item.subjectHref} className="text-[14px] font-bold text-brand-700 hover:underline">{item.subjectName}</Link> : <DataValue>{item.subjectName}</DataValue>}{item.companyName ? <DataValue>{item.companyName}</DataValue> : null}</div> : null}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]"><span className="inline-flex items-center gap-2 text-ink-500">By <DataValue>{item.actorName ?? 'System'}</DataValue></span>{item.detail ? <EventDetail text={item.detail} /> : null}</div>
                  </div>
                  <div className="col-start-2 sm:col-start-auto"><Badge tone={item.tone === 'in' ? 'green' : 'gray'}>{item.kind === 'touch' ? item.icon === 'EMAIL' ? 'Email' : item.icon === 'CALL' ? 'Call' : item.icon === 'LINKEDIN' ? 'LinkedIn' : item.icon === 'MEETING' ? 'Meeting' : KIND_LABELS[item.kind] : KIND_LABELS[item.kind]}</Badge></div>
                </li>
              ))}</ol>
            </section>
          ))}</div>
        )}
      </Surface>
      <div className="flex justify-center gap-3">{before ? <Link href={pageHref()} className="btn-secondary">Newest in this view</Link> : null}{page.hasMore ? <Link href={pageHref(page.nextCursor)} className="btn-secondary">Load older activity</Link> : null}</div>
    </div>
  );
}
