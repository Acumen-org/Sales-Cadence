import type { Prisma } from '@prisma/client';
import { meetingReadWhere } from './meetings-query';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { visiblePodIds, canSeeAllPods } from './auth/rbac';
import { cachedPersonName } from './person-cache';
import { auditDetailText, describeAudit } from './audit-format';

/**
 * Accounts are Twenty companies. Cadence adds no fields of its own: what it contributes is the
 * engagement around them - the campaigns, tasks, touches and meetings its own people generated -
 * merged into one timeline. The hierarchy shown is derived from the job titles Twenty holds, not
 * from a chart anybody maintained here.
 */

export type AccountListRow = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  city: string | null;
  ownerMemberId: string | null;
  ownerName: string | null;
  people: number;
  inSequence: number;
  replied: number;
  meetings: number;
  lastTouchAt: Date | null;
  /** True when the signed-in user owns the account or works anyone in it. */
  mine: boolean;
};

/**
 * Accounts the user may see: admins everything, everyone else the companies of their pods' people,
 * of the contacts they own in Twenty, of anyone they are the FO for - and the accounts Twenty says
 * they own, which otherwise would not appear until somebody worked a contact there.
 */
export async function accountScopeCompanyIds(user: SessionUser): Promise<string[] | null> {
  if (canSeeAllPods(user)) return null;
  const pods = visiblePodIds(user) ?? [];
  const podValues = pods.length ? (await prisma.pod.findMany({ where: { id: { in: pods } }, select: { podOwnerValue: true } })).map((p) => p.podOwnerValue) : [];
  const owned = user.twentyMemberId
    ? (await prisma.companyCache.findMany({ where: { deletedAt: null, ownerMemberId: user.twentyMemberId }, select: { id: true } })).map((c) => c.id)
    : [];
  const rows = await prisma.personCache.findMany({
    where: {
      deletedAt: null,
      companyId: { not: null },
      OR: [
        ...(podValues.length ? [{ podOwner: { in: podValues } }] : []),
        { ownerMemberId: user.twentyMemberId ?? '__none__' },
        { enrollments: { some: { foUserId: user.id } } },
      ],
    },
    select: { companyId: true },
    distinct: ['companyId'],
  });
  return [...new Set([...owned, ...rows.map((r) => r.companyId!).filter(Boolean)])];
}

export async function listAccounts(user: SessionUser, opts: { q?: string; scope?: 'all' | 'mine' } = {}): Promise<AccountListRow[]> {
  const visibleIds = await accountScopeCompanyIds(user);
  const where: Prisma.CompanyCacheWhereInput = { deletedAt: null };
  if (visibleIds !== null) where.id = { in: visibleIds };
  if (opts.q) where.OR = [{ name: { contains: opts.q, mode: 'insensitive' } }, { domain: { contains: opts.q, mode: 'insensitive' } }, { industry: { contains: opts.q, mode: 'insensitive' } }];

  const companies = await prisma.companyCache.findMany({ where, orderBy: { name: 'asc' }, take: 500 });
  const ids = companies.map((c) => c.id);
  if (!ids.length) return [];

  // Aggregate in four grouped queries rather than per-row lookups.
  const [peopleRows, enrollRows, touchRows, meetingRows, members] = await Promise.all([
    prisma.personCache.groupBy({ by: ['companyId'], where: { companyId: { in: ids }, deletedAt: null }, _count: { _all: true } }),
    prisma.enrollment.groupBy({ by: ['companyId', 'status'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    prisma.$queryRaw<Array<{ companyId: string; last: Date }>>`
      SELECT p."companyId" AS "companyId", MAX(t."occurredAt") AS last
      FROM "Touch" t JOIN "PersonCache" p ON p.id = t."personId"
      WHERE p."companyId" = ANY(${ids}) GROUP BY p."companyId"`,
    prisma.meeting.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    prisma.user.findMany({ where: { twentyMemberId: { not: null } }, select: { name: true, twentyMemberId: true } }),
  ]);

  const peopleBy = new Map(peopleRows.map((r) => [r.companyId, r._count._all]));
  const lastBy = new Map(touchRows.map((r) => [r.companyId, r.last]));
  const meetingsBy = new Map(meetingRows.map((r) => [r.companyId, r._count._all]));
  const memberName = new Map(members.map((m) => [m.twentyMemberId!, m.name]));
  const enrollBy = new Map<string, { inSequence: number; replied: number }>();
  for (const r of enrollRows) {
    if (!r.companyId) continue;
    const row = enrollBy.get(r.companyId) ?? { inSequence: 0, replied: 0 };
    if (r.status === 'ACTIVE' || r.status === 'PAUSED') row.inSequence += r._count._all;
    if (r.status === 'REPLIED' || r.status === 'MEETING') row.replied += r._count._all;
    enrollBy.set(r.companyId, row);
  }

  // "Mine": I own the account in Twenty, or I work someone in it.
  const myPeople = await prisma.personCache.findMany({
    where: { companyId: { in: ids }, OR: [{ ownerMemberId: user.twentyMemberId ?? '__none__' }, { enrollments: { some: { foUserId: user.id } } }] },
    select: { companyId: true },
    distinct: ['companyId'],
  });
  const mineIds = new Set(myPeople.map((p) => p.companyId!));

  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    domain: c.domain,
    industry: c.industry,
    city: c.city,
    ownerMemberId: c.ownerMemberId,
    ownerName: c.ownerMemberId ? memberName.get(c.ownerMemberId) ?? null : null,
    people: peopleBy.get(c.id) ?? 0,
    inSequence: enrollBy.get(c.id)?.inSequence ?? 0,
    replied: enrollBy.get(c.id)?.replied ?? 0,
    meetings: meetingsBy.get(c.id) ?? 0,
    lastTouchAt: lastBy.get(c.id) ?? null,
    mine: (user.twentyMemberId && c.ownerMemberId === user.twentyMemberId) || mineIds.has(c.id),
  }));
}

/**
 * How many accounts and relationships the signed-in user owns (Home tiles).
 * An account counts as mine when I own it in Twenty or I work anyone in it.
 */
/**
 * What this user owns, plus how much of it is live. The live counts exist so the Home tiles can
 * say something that changes rather than carry a fixed sentence describing what the tile means.
 */
export async function myOwnershipCounts(user: SessionUser): Promise<{ accounts: number; relationships: number; inSequence: number; activeAccounts: number }> {
  const member = user.twentyMemberId ?? '__none__';
  const mineWhere: Prisma.PersonCacheWhereInput = { deletedAt: null, OR: [{ ownerMemberId: member }, { enrollments: { some: { foUserId: user.id } } }] };
  const liveWhere: Prisma.PersonCacheWhereInput = { ...mineWhere, enrollments: { some: { status: { in: ['ACTIVE', 'PAUSED'] } } } };
  const [owned, viaPeople, relationships, inSequence, liveCompanies] = await Promise.all([
    prisma.companyCache.findMany({ where: { deletedAt: null, ownerMemberId: member }, select: { id: true } }),
    prisma.personCache.findMany({ where: { ...mineWhere, companyId: { not: null } }, select: { companyId: true }, distinct: ['companyId'] }),
    prisma.personCache.count({ where: mineWhere }),
    prisma.personCache.count({ where: liveWhere }),
    prisma.personCache.findMany({ where: { ...liveWhere, companyId: { not: null } }, select: { companyId: true }, distinct: ['companyId'] }),
  ]);
  const accounts = new Set<string>([...owned.map((o) => o.id), ...viaPeople.map((p) => p.companyId!)]);
  return { accounts: accounts.size, relationships, inSequence, activeAccounts: liveCompanies.length };
}

// ---------------------------------------------------------------------------
// Account detail
// ---------------------------------------------------------------------------

export type AccountPerson = {
  id: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  dnd: boolean;
  optedOut: boolean;
  podOwner: string | null;
  ownerName: string | null;
  /** What Twenty says about them, so the account page and the CRM agree. */
  tier: string | null;
  contactType: string[];
  listCategory: string | null;
  nextAction: string | null;
  nextActionDueDate: string | null;
  enrollment: { status: string; exitReason: string | null; campaignName: string | null; foName: string; foUserId: string; stepIndex: number; steps: number } | null;
  lastTouchAt: Date | null;
  touches: number;
};

export type AccountTimelineItem = {
  at: Date;
  kind: 'touch' | 'meeting' | 'task' | 'state' | 'note';
  title: string;
  detail: string | null;
  /** Labelled values for the row; `detail` is the same content on one line. */
  fields: { label: string; value: string }[];
  personId: string | null;
  personName: string | null;
  href: string | null;
  tone: 'in' | 'out' | 'neutral';
  icon: string;
};

export type AccountDetail = NonNullable<Awaited<ReturnType<typeof accountDetail>>>;

export async function accountDetail(companyId: string, user: SessionUser) {
  // The same scope the list uses. Without it the record page was reachable from any person's
  // company link, which handed a junior every contact, timeline and open task in another pod.
  const scope = await accountScopeCompanyIds(user);
  if (scope !== null && !scope.includes(companyId)) return null;
  const company = await prisma.companyCache.findUnique({ where: { id: companyId } });
  if (!company) return null;

  const [people, members, meetings, campaignRows] = await Promise.all([
    prisma.personCache.findMany({
      where: { companyId, deletedAt: null },
      orderBy: [{ lastName: 'asc' }],
      include: {
        enrollments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { fo: { select: { name: true } }, campaign: { select: { name: true } }, sequence: { select: { steps: true } } },
        },
        touches: { orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
        _count: { select: { touches: true } },
      },
    }),
    prisma.user.findMany({ where: { twentyMemberId: { not: null } }, select: { name: true, twentyMemberId: true } }),
    prisma.meeting.findMany({ where: { AND: [{ companyId }, await meetingReadWhere(user)] }, orderBy: { occurredAt: 'desc' }, include: { attendees: { select: { external: true } } } }),
    prisma.enrollment.findMany({
      where: { companyId },
      select: { campaignId: true, status: true, campaign: { select: { id: true, name: true, status: true, sequence: { select: { name: true } } } } },
    }),
  ]);

  const memberName = new Map(members.map((m) => [m.twentyMemberId!, m.name]));
  const accountPeople: AccountPerson[] = people.map((p) => {
    const e = p.enrollments[0];
    let steps = 0;
    if (e?.sequence?.steps) {
      const parsed = e.sequence.steps as unknown;
      steps = Array.isArray(parsed) ? parsed.length : 0;
    }
    return {
      id: p.id,
      name: cachedPersonName(p),
      jobTitle: p.jobTitle,
      email: p.email,
      dnd: p.dnd,
      optedOut: p.optedOut,
      podOwner: p.podOwner,
      ownerName: p.ownerMemberId ? memberName.get(p.ownerMemberId) ?? null : null,
      tier: p.tier,
      contactType: p.contactType,
      listCategory: p.listCategory,
      nextAction: p.nextAction,
      nextActionDueDate: p.nextActionDueDate,
      enrollment: e
        ? { status: e.status, exitReason: e.exitReason, campaignName: e.campaign?.name ?? null, foName: e.fo.name, foUserId: e.foUserId, stepIndex: e.currentStep, steps }
        : null,
      lastTouchAt: p.touches[0]?.occurredAt ?? null,
      touches: p._count.touches,
    };
  });

  const personIds = people.map((p) => p.id);
  const [touches, tasks, audit] = await Promise.all([
    personIds.length ? prisma.touch.findMany({ where: { personId: { in: personIds } }, orderBy: { occurredAt: 'desc' } }) : Promise.resolve([]),
    personIds.length
      ? prisma.task.findMany({
          where: { enrollment: { personId: { in: personIds } } },
          orderBy: [{ dueAt: 'desc' }],
          include: { fo: { select: { name: true } }, enrollment: { select: { personId: true, status: true, person: { select: { firstName: true, lastName: true } } } } },
        })
      : Promise.resolve([]),
    personIds.length
      ? prisma.auditLog.findMany({
          where: { entityType: 'enrollment', entityId: { in: (await prisma.enrollment.findMany({ where: { companyId }, select: { id: true } })).map((e) => e.id) } },
          orderBy: { createdAt: 'desc' },
          take: 120,
        })
      : Promise.resolve([]),
  ]);

  const nameById = new Map(accountPeople.map((p) => [p.id, p.name]));
  const enrollmentPerson = new Map<string, { id: string; name: string }>();
  for (const t of tasks) enrollmentPerson.set(t.enrollmentId, { id: t.enrollment.personId, name: `${t.enrollment.person.firstName} ${t.enrollment.person.lastName}`.trim() });

  const campaigns = [...new Map(campaignRows.filter((r) => r.campaign).map((r) => [r.campaign!.id, r.campaign!])).values()].map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    sequenceName: c.sequence.name,
    people: campaignRows.filter((r) => r.campaignId === c.id).length,
    replied: campaignRows.filter((r) => r.campaignId === c.id && (r.status === 'REPLIED' || r.status === 'MEETING')).length,
  }));

  const timeline: AccountTimelineItem[] = [
    ...touches.map<AccountTimelineItem>((t) => ({
      at: t.occurredAt,
      kind: 'touch',
      title: t.summary,
      detail: t.actorLabel,
      fields: t.actorLabel ? [{ label: 'By', value: t.actorLabel }] : [],
      personId: t.personId,
      personName: nameById.get(t.personId) ?? null,
      href: `/people/${t.personId}`,
      tone: t.direction === 'INBOUND' ? 'in' : 'out',
      icon: t.channel,
    })),
    ...meetings.map<AccountTimelineItem>((m) => ({
      at: m.occurredAt,
      kind: 'meeting',
      title: m.title,
      detail: (() => {
        const n = m.attendees.filter((a) => a.external).length;
        return `${n} external attendee${n === 1 ? '' : 's'}`;
      })(),
      fields: [{ label: 'External attendees', value: String(m.attendees.filter((a) => a.external).length) }],
      personId: null,
      personName: null,
      href: `/meetings/${m.id}`,
      tone: 'neutral',
      icon: 'MEETING',
    })),
    ...tasks
      .filter((t) => t.state !== 'PENDING')
      .map<AccountTimelineItem>((t) => ({
        at: t.completedAt ?? t.updatedAt,
        kind: 'task',
        title: `${t.label} ${t.state.toLowerCase()}${t.disposition ? ` · ${t.disposition}` : ''}`,
        detail: t.note ?? t.skipReason ?? t.fo.name,
        fields: [t.skipReason ? { label: 'Reason', value: t.skipReason } : null, t.note ? { label: 'Note', value: t.note } : null, { label: 'By', value: t.fo.name }].filter((f): f is { label: string; value: string } => Boolean(f)),
        personId: t.enrollment.personId,
        personName: nameById.get(t.enrollment.personId) ?? null,
        href: `/people/${t.enrollment.personId}`,
        tone: 'out',
        icon: t.action,
      })),
    ...audit
      .filter((a) => ['enrolled', 'replied', 'meeting', 'exited', 'completed', 'paused', 'resumed', 'finished'].includes(a.action))
      .map<AccountTimelineItem>((a) => {
        const p = enrollmentPerson.get(a.entityId);
        // Same plain-language rendering as the person timeline and the activity feed. The actor
        // goes in the detail line, not the title: "Replied" is about the prospect, and saying
        // "Replied by reconcile" would credit the observer with the reply.
        const said = describeAudit(a.action, a.details as Record<string, unknown> | null, null);
        return {
          at: a.createdAt,
          kind: 'state',
          title: said.title,
          detail: auditDetailText([...said.fields, ...(a.actorLabel ? [{ label: 'By', value: a.actorLabel }] : [])]),
          fields: [...said.fields, ...(a.actorLabel ? [{ label: 'By', value: a.actorLabel }] : [])],
          personId: p?.id ?? null,
          personName: p?.name ?? null,
          href: p ? `/people/${p.id}` : null,
          tone: 'neutral',
          icon: 'STATE',
        };
      }),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  // Held work is not open work: a paused enrollment's touches appear in no task list, so
  // counting them here would promise the FO something they cannot open.
  const openTasks = tasks.filter((t) => t.state === 'PENDING' && t.enrollment.status !== 'PAUSED');
  return {
    company,
    ownerName: company.ownerMemberId ? memberName.get(company.ownerMemberId) ?? null : null,
    people: accountPeople,
    meetings,
    campaigns,
    timeline,
    openTasks: openTasks.map((t) => ({
      id: t.id,
      label: t.label,
      action: t.action,
      due: t.snoozedTo ?? t.dueDate,
      foName: t.fo.name,
      personId: t.enrollment.personId,
      personName: nameById.get(t.enrollment.personId) ?? '',
    })),
    stats: {
      people: accountPeople.length,
      inSequence: accountPeople.filter((p) => p.enrollment && (p.enrollment.status === 'ACTIVE' || p.enrollment.status === 'PAUSED')).length,
      replied: accountPeople.filter((p) => p.enrollment && (p.enrollment.status === 'REPLIED' || p.enrollment.status === 'MEETING')).length,
      meetings: meetings.length,
      touches: accountPeople.reduce((sum, person) => sum + person.touches, 0),
      openTasks: openTasks.length,
    },
    mine: Boolean(user.twentyMemberId && company.ownerMemberId === user.twentyMemberId) || accountPeople.some((p) => p.enrollment?.foUserId === user.id),
  };
}

