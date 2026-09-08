import type { AccountRole, Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin, visiblePodIds } from './auth/rbac';
import { cachedPersonName } from './person-cache';
import { describeAudit } from './audit-format';

/**
 * Accounts are Twenty companies. Cadence adds, locally: who reports to whom (the relationship
 * map), each person's stance on the account, and a note. Nothing here is written back to Twenty.
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

/** Accounts the user may see: admins everything, others their pods' people's companies. */
export async function accountScopeCompanyIds(user: SessionUser): Promise<string[] | null> {
  if (isAdmin(user)) return null;
  const pods = visiblePodIds(user) ?? [];
  const podValues = pods.length ? (await prisma.pod.findMany({ where: { id: { in: pods } }, select: { podOwnerValue: true } })).map((p) => p.podOwnerValue) : [];
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
  return rows.map((r) => r.companyId!).filter(Boolean);
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
export async function myOwnershipCounts(user: SessionUser): Promise<{ accounts: number; relationships: number }> {
  const member = user.twentyMemberId ?? '__none__';
  const mineWhere: Prisma.PersonCacheWhereInput = { deletedAt: null, OR: [{ ownerMemberId: member }, { enrollments: { some: { foUserId: user.id } } }] };
  const [owned, viaPeople, relationships] = await Promise.all([
    prisma.companyCache.findMany({ where: { deletedAt: null, ownerMemberId: member }, select: { id: true } }),
    prisma.personCache.findMany({ where: { ...mineWhere, companyId: { not: null } }, select: { companyId: true }, distinct: ['companyId'] }),
    prisma.personCache.count({ where: mineWhere }),
  ]);
  const accounts = new Set<string>([...owned.map((o) => o.id), ...viaPeople.map((p) => p.companyId!)]);
  return { accounts: accounts.size, relationships };
}

// ---------------------------------------------------------------------------
// Account detail
// ---------------------------------------------------------------------------

export type AccountPerson = {
  id: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  reportsToId: string | null;
  accountRole: AccountRole;
  relationshipNote: string | null;
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
  enrollment: { status: string; exitReason: string | null; campaignName: string | null; foName: string; stepIndex: number; steps: number } | null;
  lastTouchAt: Date | null;
  touches: number;
};

export type AccountTreeNode = { person: AccountPerson; children: AccountTreeNode[] };

/**
 * Nest people by `reportsToId`. A manager who is not in this account, is the person themselves,
 * or would close a loop is treated as no manager, so the chart is always a forest and everyone
 * appears exactly once. Only the edge that closes a loop is cut, not the branch under it.
 */
export function buildOrgTree(people: AccountPerson[]): { roots: AccountTreeNode[]; orphans: AccountPerson[] } {
  const byId = new Map(people.map((p) => [p.id, p]));
  const nodes = new Map<string, AccountTreeNode>(people.map((p) => [p.id, { person: p, children: [] }]));
  const roots: AccountTreeNode[] = [];

  /** True when walking up from `fromId` reaches `targetId`, i.e. linking them would loop. */
  const reaches = (fromId: string, targetId: string): boolean => {
    const seen = new Set<string>();
    let cur: string | null = fromId;
    while (cur && !seen.has(cur)) {
      if (cur === targetId) return true;
      seen.add(cur);
      cur = byId.get(cur)?.reportsToId ?? null;
    }
    return false;
  };

  for (const p of people) {
    const node = nodes.get(p.id)!;
    const wanted = p.reportsToId;
    const parentId = wanted && wanted !== p.id && byId.has(wanted) && !reaches(wanted, p.id) ? wanted : null;
    if (parentId) nodes.get(parentId)!.children.push(node);
    else roots.push(node);
  }

  const sortRec = (list: AccountTreeNode[]) => {
    list.sort((a, b) => b.children.length - a.children.length || a.person.name.localeCompare(b.person.name));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  // A root with nobody under it is "unplaced": listed separately so the chart stays readable.
  const orphans = roots.filter((r) => r.children.length === 0).map((r) => r.person);
  return { roots: roots.filter((r) => r.children.length > 0), orphans };
}

export type AccountTimelineItem = {
  at: Date;
  kind: 'touch' | 'meeting' | 'task' | 'state' | 'note';
  title: string;
  detail: string | null;
  personId: string | null;
  personName: string | null;
  href: string | null;
  tone: 'in' | 'out' | 'neutral';
  icon: string;
};

export type AccountDetail = NonNullable<Awaited<ReturnType<typeof accountDetail>>>;

export async function accountDetail(companyId: string, user: SessionUser) {
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
          include: { fo: { select: { name: true } }, campaign: { select: { name: true } }, sequenceVersion: { select: { steps: true } } },
        },
        touches: { orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
        _count: { select: { touches: true } },
      },
    }),
    prisma.user.findMany({ where: { twentyMemberId: { not: null } }, select: { name: true, twentyMemberId: true } }),
    prisma.meeting.findMany({ where: { companyId }, orderBy: { occurredAt: 'desc' }, include: { attendees: { select: { external: true } } } }),
    prisma.enrollment.findMany({
      where: { companyId },
      select: { campaignId: true, status: true, campaign: { select: { id: true, name: true, status: true, sequence: { select: { name: true } } } } },
    }),
  ]);

  const memberName = new Map(members.map((m) => [m.twentyMemberId!, m.name]));
  const accountPeople: AccountPerson[] = people.map((p) => {
    const e = p.enrollments[0];
    let steps = 0;
    if (e?.sequenceVersion?.steps) {
      const parsed = e.sequenceVersion.steps as unknown;
      steps = Array.isArray(parsed) ? parsed.length : 0;
    }
    return {
      id: p.id,
      name: cachedPersonName(p),
      jobTitle: p.jobTitle,
      email: p.email,
      reportsToId: p.reportsToId,
      accountRole: p.accountRole,
      relationshipNote: p.relationshipNote,
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
        ? { status: e.status, exitReason: e.exitReason, campaignName: e.campaign?.name ?? null, foName: e.fo.name, stepIndex: e.currentStep, steps }
        : null,
      lastTouchAt: p.touches[0]?.occurredAt ?? null,
      touches: p._count.touches,
    };
  });

  const personIds = people.map((p) => p.id);
  const [touches, tasks, audit] = await Promise.all([
    personIds.length ? prisma.touch.findMany({ where: { personId: { in: personIds } }, orderBy: { occurredAt: 'desc' }, take: 120 }) : Promise.resolve([]),
    personIds.length
      ? prisma.task.findMany({
          where: { enrollment: { personId: { in: personIds } } },
          orderBy: [{ dueAt: 'desc' }],
          take: 200,
          include: { fo: { select: { name: true } }, enrollment: { select: { personId: true, person: { select: { firstName: true, lastName: true } } } } },
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
          detail: [said.detail, a.actorLabel].filter(Boolean).join(' · ') || null,
          personId: p?.id ?? null,
          personName: p?.name ?? null,
          href: p ? `/people/${p.id}` : null,
          tone: 'neutral',
          icon: 'STATE',
        };
      }),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const openTasks = tasks.filter((t) => t.state === 'PENDING');
  return {
    company,
    ownerName: company.ownerMemberId ? memberName.get(company.ownerMemberId) ?? null : null,
    people: accountPeople,
    tree: buildOrgTree(accountPeople),
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
      touches: touches.length,
      openTasks: openTasks.length,
    },
    mine: Boolean(user.twentyMemberId && company.ownerMemberId === user.twentyMemberId) || accountPeople.some((p) => p.enrollment?.foName === user.name),
  };
}

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  CHAMPION: 'Champion',
  SUPPORTER: 'Supporter',
  NEUTRAL: 'Neutral',
  DETRACTOR: 'Detractor',
  UNKNOWN: 'Unknown',
};
