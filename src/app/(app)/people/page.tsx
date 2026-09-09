import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, toActor } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { cachedPersonName } from '@/lib/person-cache';
import { getTwentyConnection } from '@/lib/settings';
import { twentyPersonUrl } from '@/lib/twenty/urls';
import { PeopleToolbar } from '@/components/people/people-toolbar';
import { PeopleTable, type PeopleTableRow } from '@/components/people/people-table';
import { IconPeople } from '@/components/icons';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { compareLocalDates, todayIn } from '@/lib/dates';
import { contactWarnings, crmStanding, EmptyState, ENROLLMENT_TONE, enrollmentStatusLabel, Surface, Toolbar, ViewHeader } from '@/components/ui';

const PAGE_SIZE = 100;

type Search = { q?: string; pod?: string; status?: string; page?: string; owner?: string; tier?: string; type?: string };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const pod = sp.pod ?? '';
  const status = sp.status ?? '';
  const owner = sp.owner === 'mine' ? 'mine' : '';
  // Only values the mapping knows are accepted, so a hand-edited URL cannot filter on nonsense.
  const values = defaultTwentySchema.personValues;
  const pick = (v: string | undefined, allowed: readonly string[]) => (v && allowed.includes(v) ? v : '');
  const tier = pick(sp.tier, values.tier);
  const contactType = pick(sp.type, values.contactType);
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const actor = toActor(user);

  const where: Prisma.PersonCacheWhereInput = { deletedAt: null };
  // "My relationships": owned by me in Twenty, or enrolled with me as the FO.
  if (owner === 'mine') {
    where.AND = [{ OR: [{ ownerMemberId: user.twentyMemberId ?? '__none__' }, { enrollments: { some: { foUserId: user.id } } }] }];
  }
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
  if (tier) where.tier = tier;
  if (contactType) where.contactType = { has: contactType };
  if (status === 'enrolled' || status === 'approaching') where.enrollments = { some: { status: { in: ['ACTIVE', 'PAUSED'] } } };
  if (status === 'not_enrolled' || status === 'cold') {
    where.enrollments = { none: {} };
    where.dnd = false;
    where.optedOut = false;
  }
  if (status === 'replied') where.enrollments = { some: { status: { in: ['REPLIED', 'MEETING'] } } };
  if (status === 'unresponsive')
    where.AND = [...((where.AND as Prisma.PersonCacheWhereInput[]) ?? []), { enrollments: { some: { status: 'COMPLETED' } } }, { enrollments: { none: { status: { in: ['ACTIVE', 'PAUSED', 'REPLIED', 'MEETING'] } } } }];
  if (status === 'dnd') where.OR = [{ dnd: true }, { optedOut: true }];
  if (status === 'bad_data')
    where.OR = [
      { badEmail: true },
      { badPhone: true },
      { emailMissing: true },
      { phoneMissing: true },
      { enrollments: { some: { status: 'EXITED', exitReason: { in: ['bounced', 'bad_data'] } } } },
    ];

  const [people, total, pods, conn] = await Promise.all([
    prisma.personCache.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        enrollments: { orderBy: { createdAt: 'desc' }, take: 1, include: { fo: { select: { id: true, name: true } }, pod: { select: { id: true, name: true } }, campaign: { select: { id: true, name: true } }, sequence: { select: { name: true } } } },
        touches: { orderBy: { occurredAt: 'desc' }, take: 8 },
      },
    }),
    prisma.personCache.count({ where }),
    prisma.pod.findMany({ orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } } }),
    getTwentyConnection(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (pod) p.set('pod', pod);
    if (status) p.set('status', status);
    if (owner) p.set('owner', owner);
    if (tier) p.set('tier', tier);
    if (contactType) p.set('type', contactType);
    p.set('page', String(n));
    return `/people?${p.toString()}`;
  };

  const today = todayIn(user.timezone);
  const podByOwner = new Map(pods.map((x) => [x.podOwnerValue, x]));

  const rows: PeopleTableRow[] = people.map((p) => {
    const e = p.enrollments[0] ?? null;
    const active = e && (e.status === 'ACTIVE' || e.status === 'PAUSED') ? e : null;
    const touch = p.touches[0];
    const cadencePod = p.podOwner ? podByOwner.get(p.podOwner) ?? null : null;
    return {
      id: p.id,
      name: cachedPersonName(p),
      jobTitle: p.jobTitle,
      companyName: p.companyName,
      podName: cadencePod?.name ?? null,
      podId: cadencePod?.id ?? null,
      standing: crmStanding(p),
      tier: p.tier,
      listCategory: p.listCategory,
      leadSource: p.leadSource,
      tags: p.tags,
      warnings: contactWarnings(p),
      next:
        p.nextAction || p.nextActionDueDate
          ? {
              action: p.nextAction,
              due: p.nextActionDueDate ? formatLocalDate(p.nextActionDueDate) : null,
              step: p.nextStep,
              overdue: Boolean(p.nextActionDueDate && compareLocalDates(p.nextActionDueDate, today) < 0),
            }
          : null,
      dnd: p.dnd,
      optedOut: p.optedOut,
      enrollment: e
        ? { status: e.status, label: enrollmentStatusLabel(e), tone: ENROLLMENT_TONE[e.status] ?? 'gray', campaignName: e.campaign?.name ?? null, campaignId: e.campaign?.id ?? null, sequenceName: e.sequence.name, foName: e.fo.name }
        : null,
      activeEnrollmentId: active?.id ?? null,
      lastTouch: touch ? { summary: touch.summary, at: formatInstant(touch.occurredAt, user.timezone) } : null,
      activity: p.touches.map((t) => ({ at: t.occurredAt.getTime(), lane: t.direction === 'INBOUND' ? ('in' as const) : ('out' as const) })),
      twentyUrl: twentyPersonUrl(conn.baseUrl, p.id),
    };
  });

  return (
    <div className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader
          title={owner === 'mine' ? 'My relationships' : q || pod || status ? 'Filtered people' : 'All people'}
          caret
          meta={`${total} result${total === 1 ? '' : 's'}`}
        />
        <Toolbar>
          <PeopleToolbar
            pods={pods.map((p) => ({ podOwnerValue: p.podOwnerValue, name: p.name }))}
            tiers={[...values.tier]}
            types={[...values.contactType]}
            q={q}
            pod={pod}
            status={status}
            tier={tier}
            type={contactType}
          />
        </Toolbar>
        {rows.length === 0 ? (
          <EmptyState icon={<IconPeople size={20} />} title="No people match" hint="Adjust the filters to find a contact." />
        ) : (
          <PeopleTable rows={rows} canEnroll={canEnroll(actor)} />
        )}
      </Surface>

      {pages > 1 ? (
        <div className="flex items-center justify-between text-[13px] text-ink-500">
          <span>
            Page <strong className="text-ink-900">{page}</strong> of <strong className="text-ink-900">{pages}</strong>
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
  );
}
