import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { describeAudit } from './audit-format';
import { cachedPersonName } from './person-cache';

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
  touch: 'Emails and calls',
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

export async function listActivity(f: ActivityFilters = {}): Promise<ActivityPage> {
  const limit = Math.min(Math.max(f.limit ?? 60, 10), 200);
  const { at: before, afterId } = parseActivityCursor(f.before);
  const wantKinds = f.kinds?.length ? new Set(f.kinds) : null;
  const q = f.q?.trim() || null;

  const wantTouches = !wantKinds || wantKinds.has('touch');
  const auditEntities = [...Object.keys(AUDIT_KIND)].filter((e) => !wantKinds || wantKinds.has(AUDIT_KIND[e]));

  // Fetch one page worth from each source, merge, then trim: correct and index-friendly.
  const auditWhere: Prisma.AuditLogWhereInput = {
    entityType: { in: auditEntities.length ? auditEntities : ['__none__'] },
    NOT: [{ entityType: { in: ADMIN_ENTITIES } }, { action: { in: ADMIN_ACTIONS } }],
    // Inclusive of the cursor instant; the id below decides where the page really resumes.
    ...(before ? { createdAt: afterId ? { lte: before } : { lt: before } } : {}),
    ...(f.actorId ? { actorId: f.actorId } : {}),
  };
  const touchWhere: Prisma.TouchWhereInput = {
    ...(before ? { occurredAt: afterId ? { lte: before } : { lt: before } } : {}),
    ...(f.actorId ? { actorUserId: f.actorId } : {}),
    ...(q ? { OR: [{ summary: { contains: q, mode: 'insensitive' } }, { person: { firstName: { contains: q, mode: 'insensitive' } } }, { person: { lastName: { contains: q, mode: 'insensitive' } } }, { person: { companyName: { contains: q, mode: 'insensitive' } } }] } : {}),
  };

  const [audits, touches, users] = await Promise.all([
    auditEntities.length
      ? prisma.auditLog.findMany({ where: auditWhere, orderBy: { createdAt: 'desc' }, take: limit + 1 })
      : Promise.resolve([]),
    wantTouches
      ? prisma.touch.findMany({
          where: touchWhere,
          orderBy: { occurredAt: 'desc' },
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
  let merged = [...auditItems, ...touchItems].sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id));
  if (q) {
    const needle = q.toLowerCase();
    merged = merged.filter((i) => [i.title, i.detail, i.actorName, i.subjectName, i.companyName].some((v) => v?.toLowerCase().includes(needle)));
  }
  if (afterId) {
    const i = merged.findIndex((x) => x.id === afterId);
    // Cursor row still there: resume just after it. Gone (deleted): fall back to a strict cut.
    merged = i >= 0 ? merged.slice(i + 1) : merged.filter((x) => !before || x.at < before);
  }
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
