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
import { PeopleTable, type PeopleTableRow } from '@/components/people/people-table';
import { SyncNow } from '@/components/people/sync-now';
import { Card, EmptyState, ENROLLMENT_TONE, enrollmentStatusLabel, PageHeader, personStage } from '@/components/ui';

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
  // Outreach-style stages as filters
  if (status === 'enrolled' || status === 'approaching') where.enrollments = { some: { status: { in: ['ACTIVE', 'PAUSED'] } } };
  if (status === 'not_enrolled' || status === 'cold') {
    where.enrollments = { none: {} };
    where.dnd = false;
    where.optedOut = false;
  }
  if (status === 'replied') where.enrollments = { some: { status: { in: ['REPLIED', 'MEETING'] } } };
  if (status === 'unresponsive') where.AND = [{ enrollments: { some: { status: 'COMPLETED' } } }, { enrollments: { none: { status: { in: ['ACTIVE', 'PAUSED', 'REPLIED', 'MEETING'] } } } }];
  if (status === 'dnd') where.OR = [{ dnd: true }, { optedOut: true }];
  if (status === 'bad_data') where.OR = [{ badEmail: true }, { badPhone: true }, { enrollments: { some: { status: 'EXITED', exitReason: { in: ['bounced', 'bad_data'] } } } }];

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
  const podIdByOwner = Object.fromEntries(pods.map((p) => [p.podOwnerValue, p.id]));
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

  const rows: PeopleTableRow[] = people.map((p) => {
    const e = p.enrollments[0] ?? null;
    const active = e && (e.status === 'ACTIVE' || e.status === 'PAUSED') ? e : null;
    const touch = p.touches[0];
    return {
      id: p.id,
      name: cachedPersonName(p),
      jobTitle: p.jobTitle,
      companyName: p.companyName,
      podOwner: p.podOwner,
      eventSource: p.eventSource,
      stage: personStage(p, e),
      dnd: p.dnd,
      optedOut: p.optedOut,
      badEmail: p.badEmail,
      badPhone: p.badPhone,
      enrollment: e ? { status: e.status, label: enrollmentStatusLabel(e), tone: ENROLLMENT_TONE[e.status] ?? 'gray', campaignName: e.campaign?.name ?? null, foName: e.fo.name } : null,
      activeEnrollmentId: active?.id ?? null,
      activeCanExit: active ? canManageEnrollment(actor, { foUserId: active.foUserId, podId: active.podId }) : false,
      lastTouch: touch ? { summary: touch.summary, at: formatInstant(touch.occurredAt, user.timezone) } : null,
      twentyUrl: twentyPersonUrl(conn.baseUrl, p.id),
    };
  });

  return (
    <>
      <PageHeader
        title="People"
        subtitle={`${total} people cached from Twenty${q || pod || status ? ' (filtered)' : ''}.`}
        actions={
          <>
            <PeopleToolbar pods={pods.map((p) => ({ podOwnerValue: p.podOwnerValue, name: p.name }))} q={q} pod={pod} status={status} />
            {isAdmin(user) ? <SyncNow /> : null}
          </>
        }
      />
      <div className="space-y-3 p-6">
        <Card>
          {rows.length === 0 ? (
            <EmptyState title="No people match" hint="Adjust the filters, or refresh the cache from Settings > Twenty." />
          ) : (
            <PeopleTable rows={rows} showActions={showActions} canEnroll={canEnroll(actor)} sequences={sequences} pods={enrolPods} podIdByOwner={podIdByOwner} />
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
