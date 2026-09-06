import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, canManageEnrollment, isAdmin, isSeniorFo, toActor, visiblePodIds } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatInstant } from '@/lib/dates';
import { cachedPersonName } from '@/lib/person-cache';
import { getTwentyConnection } from '@/lib/settings';
import { twentyPersonUrl } from '@/lib/twenty/urls';
import { PeopleToolbar } from '@/components/people/people-toolbar';
import { PersonRowActions } from '@/components/people/person-row-actions';
import { Badge, Card, EmptyState, ENROLLMENT_TONE, PageHeader } from '@/components/ui';

const PAGE_SIZE = 100;

type Search = { q?: string; pod?: string; status?: string; page?: string };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const pod = sp.pod ?? '';
  const status = sp.status ?? '';
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const actor = toActor(user);

  const where: Prisma.PersonCacheWhereInput = { deletedAt: null };
  if (q) {
    where.OR = [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { companyName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { jobTitle: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (pod) where.podOwner = pod;
  if (status === 'enrolled') where.enrollments = { some: { status: { in: ['ACTIVE', 'PAUSED'] } } };
  if (status === 'not_enrolled') where.enrollments = { none: { status: { in: ['ACTIVE', 'PAUSED'] } } };
  if (status === 'replied') where.enrollments = { some: { status: { in: ['REPLIED', 'MEETING'] } } };
  if (status === 'dnd') where.dnd = true;

  const visible = visiblePodIds(user);
  const [people, total, pods, sequences, conn] = await Promise.all([
    prisma.personCache.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        enrollments: { orderBy: { createdAt: 'desc' }, take: 1, include: { fo: { select: { id: true, name: true } }, pod: { select: { id: true, name: true } }, campaign: { select: { name: true } } } },
        touches: { orderBy: { occurredAt: 'desc' }, take: 1 },
      },
    }),
    prisma.personCache.count({ where }),
    prisma.pod.findMany({ orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } } }),
    prisma.sequence.findMany({ where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    getTwentyConnection(),
  ]);
  const enrolPods = pods.filter((p) => visible === null || visible.includes(p.id)).map((p) => ({ id: p.id, name: p.name, podOwnerValue: p.podOwnerValue, fos: p.users.filter((u) => u.user.active).map((u) => ({ id: u.user.id, name: u.user.name })) }));
  const podByOwner = new Map(pods.map((p) => [p.podOwnerValue, p.id]));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (pod) p.set('pod', pod);
    if (status) p.set('status', status);
    p.set('page', String(n));
    return `/people?${p.toString()}`;
  };
  const showActions = isAdmin(user) || isSeniorFo(user);

  return (
    <>
      <PageHeader
        title="People"
        subtitle={`${total} people cached from Twenty${q || pod || status ? ' (filtered)' : ''}.`}
        actions={<PeopleToolbar pods={pods.map((p) => ({ podOwnerValue: p.podOwnerValue, name: p.name }))} q={q} pod={pod} status={status} />}
      />
      <div className="space-y-3 p-6">
        <Card>
          {people.length === 0 ? (
            <EmptyState title="No people match" hint="Adjust the filters, or refresh the cache from Settings > Twenty." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Pod</th>
                  <th>Status</th>
                  <th>FO</th>
                  <th>Last touch</th>
                  <th>Where we met</th>
                  {showActions ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const e = p.enrollments[0];
                  const active = e && (e.status === 'ACTIVE' || e.status === 'PAUSED') ? e : null;
                  const touch = p.touches[0];
                  const url = twentyPersonUrl(conn.baseUrl, p.id);
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="font-medium text-slate-900">
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
                              {cachedPersonName(p)}
                            </a>
                          ) : (
                            cachedPersonName(p)
                          )}
                        </div>
                        <div className="text-xs text-slate-500">{p.jobTitle}</div>
                      </td>
                      <td>{p.companyName}</td>
                      <td>{p.podOwner}</td>
                      <td>
                        {p.dnd ? <Badge tone="red">DND</Badge> : null}
                        {e ? (
                          <>
                            <Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'} className={p.dnd ? 'ml-1' : undefined}>
                              {e.status.toLowerCase()}
                            </Badge>
                            {e.campaign ? <div className="text-xs text-slate-500">{e.campaign.name}</div> : null}
                          </>
                        ) : !p.dnd ? (
                          <span className="text-xs text-slate-400">not enrolled</span>
                        ) : null}
                      </td>
                      <td>{active?.fo.name ?? e?.fo.name ?? ''}</td>
                      <td className="text-xs">
                        {touch ? (
                          <>
                            <div className="text-slate-700">{touch.summary}</div>
                            <div className="text-slate-400">{formatInstant(touch.occurredAt, user.timezone)}</div>
                          </>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td>{p.eventSource}</td>
                      {showActions ? (
                        <td className="text-right">
                          <PersonRowActions
                            personId={p.id}
                            activeEnrollmentId={active?.id ?? null}
                            dnd={p.dnd}
                            canEnroll={canEnroll(actor)}
                            canExit={active ? canManageEnrollment(actor, { foUserId: active.foUserId, podId: active.podId }) : false}
                            sequences={sequences}
                            pods={enrolPods}
                            defaultPodId={p.podOwner ? podByOwner.get(p.podOwner) ?? null : null}
                          />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
        {pages > 1 ? (
          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">
                  Previous
                </Link>
              ) : null}
              {page < pages ? (
                <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">
                  Next
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
