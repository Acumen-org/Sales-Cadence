import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { auditDetailText, describeAudit, type AuditField } from './audit-format';
import { cachedPersonName } from './person-cache';
import type { SessionUser } from './auth/current-user';
import { isJuniorFo, visiblePodIds } from './auth/rbac';
import { coldRef, COLD_CONTACT_BASE, personRef, subjectHref, type AudienceScope } from './subject';
import { COUNTED_TOUCH } from './outreach/metrics';

/**
 * The Activity feed: what everyone did, newest first, CRM and Cold outreach in one feed (cold
 * outreach D2, N005) with a "Cold outreach" chip on cold rows and a CRM / Cold / All filter.
 *
 * Two sources are merged: the audit log (who changed what: steps, campaigns, people, cold contacts,
 * moves, calls and their forms, tickets) and touches (the actual emails, calls and LinkedIn
 * messages, whether a human logged them or the CRM or Outlook was seen doing them). A touch that is
 * the copy of one already counted (the CRM's copy of a cold email, a "They replied" joined to the
 * email) is not shown twice. Administration is deliberately excluded: settings changes, user and
 * pod management, and logins.
 */

export const ACTIVITY_KINDS = ['touch', 'task', 'enrollment', 'meeting', 'campaign', 'sequence', 'person', 'contact', 'call', 'ticket'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const KIND_LABELS: Record<ActivityKind, string> = {
  touch: 'Outreach',
  task: 'Tasks',
  enrollment: 'Sequence changes',
  meeting: 'Meetings',
  campaign: 'Campaigns',
  sequence: 'Sequence edits',
  person: 'People',
  contact: 'Cold contacts',
  call: 'Calls',
  ticket: 'Tickets',
};

/** Audit rows that are administration rather than outreach work. */
const ADMIN_ENTITIES = ['settings', 'user', 'pod', 'account'];
const ADMIN_ACTIONS = ['login', 'logout'];

export type ActivityItem = {
  id: string;
  at: Date;
  kind: ActivityKind;
  /** What happened, in plain language. */
  title: string;
  detail: string | null;
  /** Labelled values for the row. `detail` is the same content on one line, for search. */
  fields: AuditField[];
  /** Who did it. */
  actorName: string | null;
  actorId: string | null;
  /** Who or what it was about. */
  subjectName: string | null;
  subjectHref: string | null;
  companyName: string | null;
  icon: string;
  tone: 'in' | 'out' | 'neutral';
  /** CRM or Cold outreach, for the chip and the filter; null when neither (a call nobody is matched to yet). */
  audience: 'crm' | 'cold' | null;
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
  /** CRM, Cold outreach, or all of it (N005). */
  audience?: AudienceScope | null;
  /** Inclusive start and exclusive end, resolved from Central Time calendar dates. */
  from?: Date;
  to?: Date;
  podId?: string | null;
  viewer?: SessionUser;
};

export const parseActivityAudience = (v: string | null | undefined): AudienceScope => (v === 'crm' || v === 'cold' ? v : 'all');

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
  sandbox_contact: 'contact',
  sandbox_move: 'contact',
  bellwether: 'contact',
  suppression: 'contact',
  call: 'call',
  ticket: 'ticket',
  numberCheck: 'ticket',
};
/** Audit entities that are always cold, always CRM, or either (read from the row they point at). */
const COLD_ENTITIES = ['sandbox_contact', 'sandbox_move', 'bellwether', 'suppression'];
const CRM_ENTITIES = ['person', 'meeting', 'sequence', 'numberCheck'];

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
  // Cold work is scoped by the contact's pod and owner (N005).
  const contact: Prisma.SandboxContactWhereInput = { AND: [isJuniorFo(user) ? { ownerId: user.id } : { podId: { in: allowedPods.map((p) => p.id) } }, ...(f.podId ? [{ podId: f.podId }] : [])] };
  const [people, enrollments, tasks, campaigns, meetings, contacts, calls] = await Promise.all([
    prisma.personCache.findMany({ where: person, select: { id: true } }),
    prisma.enrollment.findMany({ where: enrollment, select: { id: true, sequenceId: true } }),
    prisma.task.findMany({ where: { enrollment }, select: { id: true } }),
    prisma.campaign.findMany({ where: { podId: { in: allowedPods.map((p) => p.id) } }, select: { id: true, sequenceId: true } }),
    prisma.meeting.findMany({ where: { review: 'APPROVED', OR: [{ attendees: { some: { person } } }, ...(!f.podId ? [{ createdById: user.id }, { attendees: { some: { userId: user.id } } }] : [])] }, select: { id: true } }),
    prisma.sandboxContact.findMany({ where: contact, select: { id: true } }),
    prisma.callLog.findMany({ where: isJuniorFo(user) ? { userId: user.id } : { podId: { in: allowedPods.map((p) => p.id) } }, select: { id: true } }),
  ]);
  const contactIds = contacts.map((c) => c.id);
  const moves = contactIds.length ? await prisma.sandboxMoveItem.findMany({ where: { sandboxContactId: { in: contactIds } }, select: { moveId: true }, distinct: ['moveId'] }) : [];
  return {
    audit: { OR: [
      { entityType: 'person', entityId: { in: people.map((p) => p.id) } },
      { entityType: 'enrollment', entityId: { in: enrollments.map((e) => e.id) } },
      { entityType: 'task', entityId: { in: tasks.map((t) => t.id) } },
      { entityType: 'campaign', entityId: { in: campaigns.map((c) => c.id) } },
      { entityType: 'meeting', entityId: { in: meetings.map((m) => m.id) } },
      { entityType: 'sequence', entityId: { in: [...enrollments, ...campaigns].map((e) => e.sequenceId) } },
      { entityType: 'sandbox_contact', entityId: { in: contactIds } },
      { entityType: 'sandbox_move', entityId: { in: moves.map((m) => m.moveId) } },
      { entityType: 'call', entityId: { in: calls.map((c) => c.id) } },
    ] },
    touch: { OR: [{ person }, { personId: null, sandboxContact: contact }] },
  };
}

function beforeWhere(field: 'createdAt' | 'occurredAt', prefix: 'a' | 't', before: Date | null, afterId: string | null) {
  if (!before) return {};
  if (!afterId) return { [field]: { lt: before } };
  const cursorPrefix = afterId.slice(0, 1);
  const sameInstant = prefix < cursorPrefix ? { [field]: before } : prefix === cursorPrefix ? { [field]: before, id: { lt: afterId.slice(2) } } : null;
  return { OR: [{ [field]: { lt: before } }, ...(sameInstant ? [sameInstant] : [])] };
}

/** A touch of this side: the audience stamped when it was written (or, before stamping, who it is about). */
function touchAudience(audience: AudienceScope): Prisma.TouchWhereInput {
  if (audience === 'all') return {};
  return audience === 'crm'
    ? { OR: [{ audience: 'CRM' }, { audience: null, personId: { not: null } }] }
    : { OR: [{ audience: 'SANDBOX' }, { audience: null, personId: null, sandboxContactId: { not: null } }] };
}

export async function listActivity(f: ActivityFilters = {}): Promise<ActivityPage> {
  const scope = await activityScope(f);
  const q = f.q?.trim().toLocaleLowerCase();
  const audience = f.audience ?? 'all';
  // Audit rows of a campaign, a step or a call are CRM or cold by the row they point at, known only
  // once they are read: those views, and a search, read page after page until enough match.
  if (!q && audience === 'all') return activityPage(f, scope);
  const keep = (item: ActivityItem) => (audience === 'all' || item.audience === audience) && (!q || [item.title, item.detail, item.actorName, item.subjectName, item.companyName].some((value) => value?.toLocaleLowerCase().includes(q)));
  const limit = Math.min(Math.max(f.limit ?? 60, 1), 200);
  const matches: ActivityItem[] = [];
  let before = f.before;
  do {
    const page = await activityPage({ ...f, q: null, before, limit: 200 }, scope);
    matches.push(...page.items.filter(keep));
    before = page.nextCursor;
    if (!before || matches.length > limit) break;
  } while (true);
  const items = matches.slice(0, limit);
  const last = items.at(-1);
  const hasMore = matches.length > limit;
  return { items, hasMore, nextCursor: hasMore && last ? `${last.at.toISOString()}|${last.id}` : null };
}

/** CRM or Cold outreach by the stamp written with the row; before stamping, by who it is about. A call nobody is matched to yet is neither. */
const sideOf = (stamp: string | null, who: { personId: string | null; sandboxContactId: string | null }): ActivityItem['audience'] =>
  stamp === 'CRM' ? 'crm' : stamp === 'SANDBOX' ? 'cold' : who.personId ? 'crm' : who.sandboxContactId ? 'cold' : null;

async function activityPage(f: ActivityFilters, scope: FeedScope): Promise<ActivityPage> {
  const limit = Math.min(Math.max(f.limit ?? 60, 1), 200);
  const { at: before, afterId } = parseActivityCursor(f.before);
  const wantKinds = f.kinds?.length ? new Set(f.kinds) : null;
  const audience = f.audience ?? 'all';

  const wantTouches = !wantKinds || wantKinds.has('touch');
  // The entities this view can hold at all: a CRM view never reads cold-only ones, and the reverse.
  const auditEntities = f.channel ? [] : [...Object.keys(AUDIT_KIND)].filter((e) => (!wantKinds || wantKinds.has(AUDIT_KIND[e])) && !(audience === 'crm' && COLD_ENTITIES.includes(e)) && !(audience === 'cold' && CRM_ENTITIES.includes(e)));

  // Fetch one page worth from each source, merge, then trim: correct and index-friendly.
  const auditWhere: Prisma.AuditLogWhereInput = {
    entityType: { in: auditEntities.length ? auditEntities : ['__none__'] },
    NOT: [{ entityType: { in: ADMIN_ENTITIES } }, { action: { in: ADMIN_ACTIONS } }],
    AND: [scope.audit, beforeWhere('createdAt', 'a', before, afterId)],
    createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) },
    ...(f.actorId ? { actorId: f.actorId } : {}),
  };
  const touchWhere: Prisma.TouchWhereInput = {
    AND: [scope.touch, beforeWhere('occurredAt', 't', before, afterId), COUNTED_TOUCH, touchAudience(audience)],
    occurredAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) },
    ...(f.channel ? { channel: f.channel } : {}),
    ...(f.actorId ? { actorUserId: f.actorId } : {}),
  };

  const who = { select: { id: true, firstName: true, lastName: true, companyName: true } } as const;
  const [audits, touches, users] = await Promise.all([
    auditEntities.length
      ? prisma.auditLog.findMany({ where: auditWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
      : Promise.resolve([]),
    wantTouches
      ? prisma.touch.findMany({ where: touchWhere, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limit + 1, include: { person: who, sandboxContact: who } })
      : Promise.resolve([]),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);

  const userName = new Map(users.map((u) => [u.id, u.name]));

  // Audit rows point at entities; resolve the ones worth naming in batched queries.
  const ids = (type: string) => audits.filter((a) => a.entityType === type).map((a) => a.entityId);
  const subject = { personId: true, sandboxContactId: true, person: { select: { firstName: true, lastName: true, companyName: true } }, sandboxContact: { select: { firstName: true, lastName: true, companyName: true } } } as const;
  const [tasks, enrollments, meetings, persons, campaigns, sequences, contacts, calls, tickets, moves] = await Promise.all([
    ids('task').length ? prisma.task.findMany({ where: { id: { in: ids('task') } }, select: { id: true, label: true, action: true, enrollment: { select: { ...subject, audience: true } } } }) : Promise.resolve([]),
    ids('enrollment').length ? prisma.enrollment.findMany({ where: { id: { in: ids('enrollment') } }, select: { id: true, audience: true, ...subject } }) : Promise.resolve([]),
    ids('meeting').length ? prisma.meeting.findMany({ where: { id: { in: ids('meeting') } }, select: { id: true, title: true, companyName: true } }) : Promise.resolve([]),
    ids('person').length ? prisma.personCache.findMany({ where: { id: { in: ids('person') } }, select: { id: true, firstName: true, lastName: true, companyName: true } }) : Promise.resolve([]),
    ids('campaign').length ? prisma.campaign.findMany({ where: { id: { in: ids('campaign') } }, select: { id: true, name: true, audience: true } }) : Promise.resolve([]),
    ids('sequence').length ? prisma.sequence.findMany({ where: { id: { in: ids('sequence') } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ids('sandbox_contact').length ? prisma.sandboxContact.findMany({ where: { id: { in: ids('sandbox_contact') } }, select: { id: true, firstName: true, lastName: true, companyName: true } }) : Promise.resolve([]),
    ids('call').length ? prisma.callLog.findMany({ where: { id: { in: ids('call') } }, select: { id: true, audience: true, ...subject } }) : Promise.resolve([]),
    ids('ticket').length ? prisma.ticket.findMany({ where: { id: { in: ids('ticket') } }, select: { id: true, ...subject } }) : Promise.resolve([]),
    ids('sandbox_move').length ? prisma.sandboxMove.findMany({ where: { id: { in: ids('sandbox_move') } }, select: { id: true, count: true } }) : Promise.resolve([]),
  ]);
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const taskById = byId(tasks), enrollmentById = byId(enrollments), meetingById = byId(meetings), personById = byId(persons), campaignById = byId(campaigns), sequenceById = byId(sequences), contactById = byId(contacts), callById = byId(calls), ticketById = byId(tickets), moveById = byId(moves);

  /** A row about a person or a cold contact: its name, its own page, its firm. */
  const about = (r: { personId: string | null; sandboxContactId: string | null; person: { firstName: string; lastName: string; companyName: string | null } | null; sandboxContact: { firstName: string; lastName: string; companyName: string | null } | null }) => {
    const w = r.person ?? r.sandboxContact;
    const ref = r.personId ? personRef(r.personId) : r.sandboxContactId ? coldRef(r.sandboxContactId) : null;
    return { subjectName: w ? cachedPersonName(w) : null, subjectHref: ref ? subjectHref(ref) : null, companyName: w?.companyName ?? null };
  };

  const auditItems: ActivityItem[] = audits.map((a) => {
    const kind = AUDIT_KIND[a.entityType] ?? 'person';
    const actorName = a.actorType === 'USER' ? (a.actorId ? userName.get(a.actorId) ?? a.actorLabel : a.actorLabel) : a.actorLabel;
    const { title, fields } = describeAudit(a.action, a.details as Record<string, unknown> | null, null, a.entityType);
    let named: { subjectName: string | null; subjectHref: string | null; companyName: string | null } = { subjectName: null, subjectHref: null, companyName: null };
    let icon = 'STATE';
    let side: ActivityItem['audience'] = COLD_ENTITIES.includes(a.entityType) ? 'cold' : CRM_ENTITIES.includes(a.entityType) ? 'crm' : null;

    if (a.entityType === 'task') {
      const t = taskById.get(a.entityId);
      if (t) { named = about(t.enrollment); icon = t.action; side = sideOf(t.enrollment.audience, t.enrollment); }
    } else if (a.entityType === 'enrollment') {
      const e = enrollmentById.get(a.entityId);
      if (e) { named = about(e); side = sideOf(e.audience, e); }
    } else if (a.entityType === 'meeting') {
      const m = meetingById.get(a.entityId);
      if (m) { named = { subjectName: m.title, subjectHref: `/meetings/${m.id}`, companyName: m.companyName }; icon = 'MEETING'; }
    } else if (a.entityType === 'person') {
      const p = personById.get(a.entityId);
      if (p) named = { subjectName: cachedPersonName(p), subjectHref: subjectHref(personRef(p.id)), companyName: p.companyName };
    } else if (a.entityType === 'campaign') {
      const c = campaignById.get(a.entityId);
      if (c) { named = { subjectName: c.name, subjectHref: `/campaigns/${c.id}`, companyName: null }; side = c.audience === 'SANDBOX' ? 'cold' : 'crm'; }
    } else if (a.entityType === 'sequence') {
      const s = sequenceById.get(a.entityId);
      if (s) named = { subjectName: s.name, subjectHref: `/sequences/${s.id}`, companyName: null };
    } else if (a.entityType === 'sandbox_contact') {
      const c = contactById.get(a.entityId);
      if (c) named = { subjectName: cachedPersonName(c), subjectHref: subjectHref(coldRef(c.id)), companyName: c.companyName };
    } else if (a.entityType === 'sandbox_move') {
      const m = moveById.get(a.entityId);
      if (m) named = { subjectName: m.count === 1 ? 'One contact' : `${m.count} contacts`, subjectHref: `${COLD_CONTACT_BASE}/moves/${m.id}`, companyName: null };
    } else if (a.entityType === 'call') {
      const c = callById.get(a.entityId);
      icon = 'CALL';
      if (c) { named = about(c); named.subjectHref = named.subjectHref ?? `/calls/${c.id}`; side = sideOf(c.audience, c); }
    } else if (a.entityType === 'ticket') {
      const t = ticketById.get(a.entityId);
      if (t) { named = about(t); side = t.personId ? 'crm' : t.sandboxContactId ? 'cold' : null; }
    }

    return { id: `a:${a.id}`, at: a.createdAt, kind, title, detail: auditDetailText(fields), fields, actorName: actorName ?? null, actorId: a.actorId ?? null, ...named, icon, tone: 'neutral', audience: side };
  });

  const touchItems: ActivityItem[] = touches.map((t) => ({
    id: `t:${t.id}`,
    at: t.occurredAt,
    kind: 'touch',
    title: t.summary,
    detail: t.direction === 'INBOUND' ? 'Inbound' : 'Outbound',
    fields: [{ label: 'Direction', value: t.direction === 'INBOUND' ? 'Inbound' : 'Outbound' }],
    actorName: t.actorUserId ? userName.get(t.actorUserId) ?? t.actorLabel : t.actorLabel,
    actorId: t.actorUserId ?? null,
    ...about(t),
    icon: t.channel,
    tone: t.direction === 'INBOUND' ? 'in' : 'out',
    audience: sideOf(t.audience, t),
  }));

  // Newest first, with the id as a tie-break so the order is total and paging cannot loop.
  const merged = [...auditItems, ...touchItems].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const page = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.at.toISOString()}|${last.id}` : null;
  return { items: page, nextCursor, hasMore };
}

/** Per-person counts for the "who did what" strip, over a window: CRM and cold work alike, each email once. */
export async function activityByUser(since: Date): Promise<Array<{ id: string; name: string; touches: number; tasks: number }>> {
  const [users, touchRows, taskRows] = await Promise.all([
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.touch.groupBy({ by: ['actorUserId'], where: { occurredAt: { gte: since }, actorUserId: { not: null }, ...COUNTED_TOUCH }, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['foUserId'], where: { state: 'DONE', completedAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const touchBy = new Map(touchRows.map((r) => [r.actorUserId!, r._count._all]));
  const taskBy = new Map(taskRows.map((r) => [r.foUserId, r._count._all]));
  return users
    .map((u) => ({ id: u.id, name: u.name, touches: touchBy.get(u.id) ?? 0, tasks: taskBy.get(u.id) ?? 0 }))
    .filter((u) => u.touches || u.tasks)
    .sort((a, b) => b.touches + b.tasks - (a.touches + a.tasks));
}
