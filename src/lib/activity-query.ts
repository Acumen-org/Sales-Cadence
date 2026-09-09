import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { describeAudit } from './audit-format';
import { cachedPersonName } from './person-cache';
import type { SessionUser } from './auth/current-user';
import { isJuniorFo, visiblePodIds } from './auth/rbac';

/**
 * The Activity feed: what everyone did, newest first.
 *
 * Two sources are merged: the audit log (who changed what) and touches (the actual emails, calls
 * and LinkedIn messages, whether a human logged them or Twenty was observed doing them).
 * Administration is deliberately excluded: settings changes, user and pod management, and logins.
 */

export const ACTIVITY_KINDS = ['touch', 'task', 'enrollment', 'meeting', 'campaign', 'sequence', 'person'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const KIND_LABELS: Record<ActivityKind, string> = {
  touch: 'Outreach',
  task: 'Tasks',
  enrollment: 'Sequence changes',
  meeting: 'Meetings',
  campaign: 'Campaigns',
  sequence: 'Sequence edits',
  person: 'People',
};

/** Audit rows that are administration rather than outreach work. */
const ADMIN_ENTITIES = ['settings', 'user', 'pod'];
const ADMIN_ACTIONS = ['login', 'logout'];

export type ActivityItem = {
  id: string;
  at: Date;
  kind: ActivityKind;
  /** What happened, in plain language. */
  title: string;
  detail: string | null;
  /** Who did it. */
  actorName: string | null;
  actorId: string | null;
  /** Who or what it was about. */
  subjectName: string | null;
  subjectHref: string | null;
  companyName: string | null;
  icon: string;
  tone: 'in' | 'out' | 'neutral';
};

export type ActivityFilters = {
  /**
   * Cursor from a previous page's `nextCursor`: an instant, optionally with the last item's id
   * after a pipe. Seeded and imported rows often share a timestamp, so the id is what makes
   * "older than this" exact instead of losing every row on the boundary second.
   */
  before?: Date | string | null;
  limit?: number;
  actorId?: string | null;
  kinds?: ActivityKind[] | null;
  q?: string | null;
  channel?: 'EMAIL' | 'CALL' | 'LINKEDIN' | null;
  /** Inclusive start and exclusive end, resolved from Central Time calendar dates. */
  from?: Date;
  to?: Date;
  podId?: string | null;
  viewer?: SessionUser;
};

/** `2026-09-08T10:00:00.000Z|t:abc` -> instant plus the id to resume after. */
export function parseActivityCursor(cursor: Date | string | null | undefined): { at: Date | null; afterId: string | null } {
  if (!cursor) return { at: null, afterId: null };
  if (cursor instanceof Date) return { at: Number.isNaN(cursor.getTime()) ? null : cursor, afterId: null };
  const [iso, id] = cursor.split('|');
  const at = new Date(iso);
  return { at: Number.isNaN(at.getTime()) ? null : at, afterId: id || null };
}

export type ActivityPage = { items: ActivityItem[]; nextCursor: string | null; hasMore: boolean };

const AUDIT_KIND: Record<string, ActivityKind> = {
  task: 'task',
  enrollment: 'enrollment',
  meeting: 'meeting',
  campaign: 'campaign',
  sequence: 'sequence',
  person: 'person',
};

type FeedScope = { audit: Prisma.AuditLogWhereInput; touch: Prisma.TouchWhereInput };

/** Audit entities have no SQL relation, so resolve the allowed records before paging. */
async function activityScope(f: ActivityFilters): Promise<FeedScope> {
  if (!f.viewer) return { audit: {}, touch: {} };
  const user = f.viewer;
  const pods = visiblePodIds(user);
  if (pods === null && !f.podId) return { audit: {}, touch: {} };
  const enrollmentBase: Prisma.EnrollmentWhereInput = isJuniorFo(user) ? { foUserId: user.id } : pods === null ? {} : { OR: [{ foUserId: user.id }, { podId: { in: pods } }] };
  const enrollment: Prisma.EnrollmentWhereInput = { AND: [enrollmentBase, ...(f.podId ? [{ podId: f.podId }] : [])] };
  const allowedPods = await prisma.pod.findMany({ where: { AND: [pods === null ? {} : { id: { in: pods } }, ...(f.podId ? [{ id: f.podId }] : [])] }, select: { id: true, podOwnerValue: true } });
  const personBase: Prisma.PersonCacheWhereInput = isJuniorFo(user)
    ? { OR: [{ ownerMemberId: user.twentyMemberId ?? '__none__' }, { enrollments: { some: enrollmentBase } }] }
    : { OR: [{ podOwner: { in: allowedPods.map((p) => p.podOwnerValue) } }, { ownerMemberId: user.twentyMemberId ?? '__none__' }, { enrollments: { some: enrollmentBase } }] };
  const person: Prisma.PersonCacheWhereInput = { AND: [personBase, ...(f.podId ? [{ OR: [{ podOwner: { in: allowedPods.map((p) => p.podOwnerValue) } }, { enrollments: { some: enrollment } }] }] : [])] };
  const [people, enrollments, tasks, campaigns, meetings] = await Promise.all([
    prisma.personCache.findMany({ where: person, select: { id: true } }),
    prisma.enrollment.findMany({ where: enrollment, select: { id: true, sequenceId: true } }),
    prisma.task.findMany({ where: { enrollment }, select: { id: true } }),
    prisma.campaign.findMany({ where: { podId: { in: allowedPods.map((p) => p.id) } }, select: { id: true, sequenceId: true } }),
    prisma.meeting.findMany({ where: { OR: [{ attendees: { some: { person } } }, ...(!f.podId ? [{ createdById: user.id }, { attendees: { some: { userId: user.id } } }] : [])] }, select: { id: true } }),
  ]);
  return {
    audit: { OR: [
      { entityType: 'person', entityId: { in: people.map((p) => p.id) } },
      { entityType: 'enrollment', entityId: { in: enrollments.map((e) => e.id) } },
      { entityType: 'task', entityId: { in: tasks.map((t) => t.id) } },
      { entityType: 'campaign', entityId: { in: campaigns.map((c) => c.id) } },
      { entityType: 'meeting', entityId: { in: meetings.map((m) => m.id) } },
      { entityType: 'sequence', entityId: { in: [...enrollments, ...campaigns].map((e) => e.sequenceId) } },
    ] },
    touch: { person },
  };
}

function beforeWhere(field: 'createdAt' | 'occurredAt', prefix: 'a' | 't', before: Date | null, afterId: string | null) {
  if (!before) return {};
  if (!afterId) return { [field]: { lt: before } };
  const cursorPrefix = afterId.slice(0, 1);
  const sameInstant = prefix < cursorPrefix ? { [field]: before } : prefix === cursorPrefix ? { [field]: before, id: { lt: afterId.slice(2) } } : null;
  return { OR: [{ [field]: { lt: before } }, ...(sameInstant ? [sameInstant] : [])] };
}

export async function listActivity(f: ActivityFilters = {}): Promise<ActivityPage> {
  const scope = await activityScope(f);
  const q = f.q?.trim().toLocaleLowerCase();
  if (!q) return activityPage(f, scope);
  // Search resolved names and event details across successive pages, not only the first batch.
  const limit = Math.min(Math.max(f.limit ?? 60, 1), 200);
  const matches: ActivityItem[] = [];
  let before = f.before;
  do {
    const page = await activityPage({ ...f, q: null, before, limit: 200 }, scope);
    matches.push(...page.items.filter((item) => [item.title, item.detail, item.actorName, item.subjectName, item.companyName].some((value) => value?.toLocaleLowerCase().includes(q))));
    before = page.nextCursor;
    if (!before || matches.length > limit) break;
  } while (true);
  const items = matches.slice(0, limit);
  const last = items.at(-1);
  const hasMore = matches.length > limit;
  return { items, hasMore, nextCursor: hasMore && last ? `${last.at.toISOString()}|${last.id}` : null };
}

async function activityPage(f: ActivityFilters, scope: FeedScope): Promise<ActivityPage> {
  const limit = Math.min(Math.max(f.limit ?? 60, 1), 200);
  const { at: before, afterId } = parseActivityCursor(f.before);
  const wantKinds = f.kinds?.length ? new Set(f.kinds) : null;

  const wantTouches = !wantKinds || wantKinds.has('touch');
  const auditEntities = f.channel ? [] : [...Object.keys(AUDIT_KIND)].filter((e) => !wantKinds || wantKinds.has(AUDIT_KIND[e]));

  // Fetch one page worth from each source, merge, then trim: correct and index-friendly.
  const auditWhere: Prisma.AuditLogWhereInput = {
    entityType: { in: auditEntities.length ? auditEntities : ['__none__'] },
    NOT: [{ entityType: { in: ADMIN_ENTITIES } }, { action: { in: ADMIN_ACTIONS } }],
    AND: [scope.audit, beforeWhere('createdAt', 'a', before, afterId)],
    createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) },
    ...(f.actorId ? { actorId: f.actorId } : {}),
  };
  const touchWhere: Prisma.TouchWhereInput = {
    AND: [scope.touch, beforeWhere('occurredAt', 't', before, afterId)],
    occurredAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) },
    ...(f.channel ? { channel: f.channel } : {}),
    ...(f.actorId ? { actorUserId: f.actorId } : {}),
  };

  const [audits, touches, users] = await Promise.all([
    auditEntities.length
      ? prisma.auditLog.findMany({ where: auditWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
      : Promise.resolve([]),
    wantTouches
      ? prisma.touch.findMany({
          where: touchWhere,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          include: { person: { select: { id: true, firstName: true, lastName: true, companyName: true } } },
        })
      : Promise.resolve([]),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);

  const userName = new Map(users.map((u) => [u.id, u.name]));

  // Audit rows point at entities; resolve the ones worth naming in two batched queries.
  const taskIds = audits.filter((a) => a.entityType === 'task').map((a) => a.entityId);
  const enrollmentIds = audits.filter((a) => a.entityType === 'enrollment').map((a) => a.entityId);
  const meetingIds = audits.filter((a) => a.entityType === 'meeting').map((a) => a.entityId);
  const personIds = audits.filter((a) => a.entityType === 'person').map((a) => a.entityId);
  const campaignIds = audits.filter((a) => a.entityType === 'campaign').map((a) => a.entityId);
  const sequenceIds = audits.filter((a) => a.entityType === 'sequence').map((a) => a.entityId);

  const [tasks, enrollments, meetings, persons, campaigns, sequences] = await Promise.all([
    taskIds.length
      ? prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, label: true, action: true, enrollment: { select: { personId: true, person: { select: { firstName: true, lastName: true, companyName: true } } } } } })
      : Promise.resolve([]),
    enrollmentIds.length
      ? prisma.enrollment.findMany({ where: { id: { in: enrollmentIds } }, select: { id: true, personId: true, person: { select: { firstName: true, lastName: true, companyName: true } } } })
      : Promise.resolve([]),
    meetingIds.length ? prisma.meeting.findMany({ where: { id: { in: meetingIds } }, select: { id: true, title: true, companyName: true } }) : Promise.resolve([]),
    personIds.length ? prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, firstName: true, lastName: true, companyName: true } }) : Promise.resolve([]),
    campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    sequenceIds.length ? prisma.sequence.findMany({ where: { id: { in: sequenceIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const enrollmentById = new Map(enrollments.map((e) => [e.id, e]));
  const meetingById = new Map(meetings.map((m) => [m.id, m]));
  const personById = new Map(persons.map((p) => [p.id, p]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const sequenceById = new Map(sequences.map((s) => [s.id, s]));

  const auditItems: ActivityItem[] = audits.map((a) => {
    const kind = AUDIT_KIND[a.entityType] ?? 'person';
    const actorName = a.actorType === 'USER' ? (a.actorId ? userName.get(a.actorId) ?? a.actorLabel : a.actorLabel) : a.actorLabel;
    const { title, detail } = describeAudit(a.action, a.details as Record<string, unknown> | null, null);

    let subjectName: string | null = null;
    let subjectHref: string | null = null;
    let companyName: string | null = null;
    let icon = 'STATE';

    if (kind === 'task') {
      const t = taskById.get(a.entityId);
      if (t) {
        subjectName = cachedPersonName(t.enrollment.person);
        subjectHref = `/people/${t.enrollment.personId}`;
        companyName = t.enrollment.person.companyName;
        icon = t.action;
      }
    } else if (kind === 'enrollment') {
      const e = enrollmentById.get(a.entityId);
      if (e) {
        subjectName = cachedPersonName(e.person);
        subjectHref = `/people/${e.personId}`;
        companyName = e.person.companyName;
      }
    } else if (kind === 'meeting') {
      const m = meetingById.get(a.entityId);
      if (m) {
        subjectName = m.title;
        subjectHref = `/meetings/${m.id}`;
        companyName = m.companyName;
        icon = 'MEETING';
      }
    } else if (kind === 'person') {
      const p = personById.get(a.entityId);
      if (p) {
        subjectName = cachedPersonName(p);
        subjectHref = `/people/${p.id}`;
        companyName = p.companyName;
      }
    } else if (kind === 'campaign') {
      const c = campaignById.get(a.entityId);
      if (c) {
        subjectName = c.name;
        subjectHref = `/campaigns/${c.id}`;
      }
    } else if (kind === 'sequence') {
      const s = sequenceById.get(a.entityId);
      if (s) {
        subjectName = s.name;
        subjectHref = `/sequences/${s.id}`;
      }
    }

    return {
      id: `a:${a.id}`,
      at: a.createdAt,
      kind,
      title,
      detail,
      actorName: actorName ?? null,
      actorId: a.actorId ?? null,
      subjectName,
      subjectHref,
      companyName,
      icon,
      tone: 'neutral',
    };
  });

  const touchItems: ActivityItem[] = touches.map((t) => ({
    id: `t:${t.id}`,
    at: t.occurredAt,
    kind: 'touch',
    title: t.summary,
    detail: t.direction === 'INBOUND' ? 'Inbound' : 'Outbound',
    actorName: t.actorUserId ? userName.get(t.actorUserId) ?? t.actorLabel : t.actorLabel,
    actorId: t.actorUserId ?? null,
    subjectName: cachedPersonName(t.person),
    subjectHref: `/people/${t.person.id}`,
    companyName: t.person.companyName,
    icon: t.channel,
    tone: t.direction === 'INBOUND' ? 'in' : 'out',
  }));

  // Newest first, with the id as a tie-break so the order is total and paging cannot loop.
  const merged = [...auditItems, ...touchItems].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const page = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.at.toISOString()}|${last.id}` : null;
  return { items: page, nextCursor, hasMore };
}

/** Per-person counts for the "who did what" strip, over a window. */
export async function activityByUser(since: Date): Promise<Array<{ id: string; name: string; touches: number; tasks: number }>> {
  const [users, touchRows, taskRows] = await Promise.all([
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.touch.groupBy({ by: ['actorUserId'], where: { occurredAt: { gte: since }, actorUserId: { not: null } }, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['foUserId'], where: { state: 'DONE', completedAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const touchBy = new Map(touchRows.map((r) => [r.actorUserId!, r._count._all]));
  const taskBy = new Map(taskRows.map((r) => [r.foUserId, r._count._all]));
  return users
    .map((u) => ({ id: u.id, name: u.name, touches: touchBy.get(u.id) ?? 0, tasks: taskBy.get(u.id) ?? 0 }))
    .filter((u) => u.touches || u.tasks)
    .sort((a, b) => b.touches + b.tasks - (a.touches + a.tasks));
}
