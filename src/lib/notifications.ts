import type { Prisma, Role } from '@prisma/client';
import type { SessionUser } from './auth/current-user';
import { prisma } from './db';
import { cachedPersonName } from './person-cache';
import { formatLocalDate, isLocalDate } from './dates';
import { COLD_CONTACT_BASE, coldRef, personRef, subjectHref } from './subject';

/**
 * The bell. Two kinds of thing ring it:
 *  - a CRM person's email reply, read from the touches themselves (as it always has), and
 *  - a Notification row: everything else, each written for the people it concerns when it happens.
 *
 * Notification kinds, and who writes them:
 *   reply                 a cold contact's reply, seen in a mailbox or in the CRM's mail (W10)
 *   bounce                an email to a cold contact bounced: its email steps are skipped (W10)
 *   possible_bounce       a notice that may be a bounce: "Check the address" (W10, N097)
 *   compliance_alert      an email went to someone who must not be contacted (W10, N016)
 *   next_step_suggestion  a colleague's next step offered to the owner (S4, B027)
 *   call_flag             a call leaders should look at, such as a long voicemail (S4, B025)
 *   move_finished         a Move to CRM is done, with its counts (S3, B036)
 *   retention_warning     some of the owner's cold contacts are due for removal (S2, N032)
 *
 * Read and unread work as they always have: "Mark read" marks everything up to the moment the list
 * was opened (`User.notificationsReadAt`); a Notification row also keeps its own `readAt`, set then
 * or when it is answered (a suggestion accepted or dismissed).
 */

export type NotificationKind = 'reply' | 'bounce' | 'possible_bounce' | 'compliance_alert' | 'next_step_suggestion' | 'call_flag' | 'move_finished' | 'retention_warning';

type Tx = Prisma.TransactionClient | typeof prisma;

/** A CRM reply touch was an auto-reply when its summary says so (ingest.ts writes "Auto-reply: ..."). */
const AUTO_REPLY: Prisma.TouchWhereInput = { summary: { startsWith: 'Auto-reply' } };

/**
 * The CRM replies the bell rings for: from people this user is responsible for.
 *
 * Responsibility is either of two things, and both matter. Twenty's own owner (`ownerMemberId`) is
 * one; the other is being the FO on the enrollment, because a round-robin campaign hands an FO
 * people who are owned by somebody else in the CRM - and the person who sent the email is exactly
 * the person who needs to know it was answered. Scoping on the Twenty owner alone left those
 * replies unnotified, and left a user with no `twentyMemberId` with a bell that could never ring.
 *
 * An out-of-office answers nobody, so it never rings (N064). Cold contacts' replies ring through
 * Notification rows, written for the campaign's rep, the mailbox owner and the owner (or the pod's
 * leaders when nobody owns the contact).
 */
export function notificationScope(user: Pick<SessionUser, 'id' | 'twentyMemberId'>): Prisma.TouchWhereInput {
  const owned: Prisma.PersonCacheWhereInput[] = [{ enrollments: { some: { foUserId: user.id } } }];
  if (user.twentyMemberId) owned.push({ ownerMemberId: user.twentyMemberId });
  return { channel: 'EMAIL', direction: 'INBOUND', NOT: AUTO_REPLY, person: { deletedAt: null, OR: owned } };
}

/** Ring the bell of each of these users, once each. Returns how many were told. */
export async function notify(userIds: Array<string | null | undefined>, data: { kind: NotificationKind; personId?: string | null; sandboxContactId?: string | null; fromUserId?: string | null; payload: Prisma.InputJsonValue }, tx: Tx = prisma): Promise<number> {
  const to = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (!to.length) return 0;
  const { count } = await tx.notification.createMany({ data: to.map((userId) => ({ userId, kind: data.kind, personId: data.personId ?? null, sandboxContactId: data.sandboxContactId ?? null, fromUserId: data.fromUserId ?? null, payload: data.payload })) });
  return count;
}

/** The active Sales Leaders and Pod Managers of these pods. */
export async function podLeaders(podIds: Array<string | null | undefined>, tx: Tx = prisma): Promise<string[]> {
  const pods = [...new Set(podIds.filter((id): id is string => Boolean(id)))];
  if (!pods.length) return [];
  const leaders = await tx.user.findMany({ where: { active: true, role: { in: ['SALES_LEADER', 'POD_MANAGER'] }, pods: { some: { podId: { in: pods } } } }, select: { id: true } });
  return leaders.map((l) => l.id);
}

/** Rows of mine not read yet: unanswered and newer than my last "Mark read". */
function unreadRows(userId: string, readAt: Date | null): Prisma.NotificationWhereInput {
  return { userId, readAt: null, ...(readAt ? { createdAt: { gt: readAt } } : {}) };
}

export async function unreadNotifications(user: Pick<SessionUser, 'id' | 'twentyMemberId'>): Promise<number> {
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { notificationsReadAt: true } });
  const read = current.notificationsReadAt;
  const [touches, rows] = await Promise.all([
    prisma.touch.count({ where: { ...notificationScope(user), ...(read ? { createdAt: { gt: read } } : {}) } }),
    prisma.notification.count({ where: unreadRows(user.id, read) }),
  ]);
  return touches + rows;
}

/** One line in the bell. `href` is the thing it is about; a suggestion carries its answer. */
export type BellItem = {
  id: string;
  kind: NotificationKind | 'crm_reply';
  /** Who or what it is about, shown first. */
  name: string;
  company: string | null;
  /** What happened, in a sentence. */
  title: string;
  detail: string | null;
  href: string | null;
  /** The link's words, for a screen reader and the visible link. */
  linkLabel: string;
  at: string;
  unread: boolean;
  suggestion?: { id: string; resolution: string | null; mayAccept: boolean };
};

const PAGE = 25;
type Key = { at: Date; id: string };
const keyOf = (k: Key) => `${k.at.toISOString()}~${k.id}`;
function parseKey(cursor: string | null | undefined): Key | null {
  if (!cursor) return null;
  const [iso, id] = cursor.split('~');
  const at = new Date(iso ?? '');
  return id && Number.isFinite(at.getTime()) ? { at, id } : null;
}
/** Newest first, by when it arrived and then id, so two sources page as one list. */
const before = (k: Key | null) => (k ? { OR: [{ createdAt: { lt: k.at } }, { createdAt: k.at, id: { lt: k.id } }] } : {});
const newer = (a: Key, b: Key) => b.at.getTime() - a.at.getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);

const ACTION_WORDS: Record<string, string> = { CALL: 'Call', EMAIL: 'Email', LINKEDIN_MESSAGE: 'LinkedIn message', LINKEDIN_CONNECT: 'LinkedIn connect' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

type Row = Prisma.NotificationGetPayload<object>;
type Names = { people: Map<string, { name: string; company: string | null }>; contacts: Map<string, { name: string; company: string | null }>; users: Map<string, string> };

/** What a Notification row says, in plain words, and where it leads. */
export function bellWords(n: Pick<Row, 'id' | 'kind' | 'personId' | 'sandboxContactId' | 'fromUserId' | 'payload' | 'resolution'>, names: Names, viewer?: { role: Role }): Omit<BellItem, 'id' | 'at' | 'unread'> {
  const p = (n.payload ?? {}) as Record<string, unknown>;
  const who = n.personId ? names.people.get(n.personId) : n.sandboxContactId ? names.contacts.get(n.sandboxContactId) : null;
  const subjectLink = n.personId ? subjectHref(personRef(n.personId)) : n.sandboxContactId ? subjectHref(coldRef(n.sandboxContactId)) : null;
  const from = (n.fromUserId ? names.users.get(n.fromUserId) : null) ?? str(p.from) ?? 'A colleague';
  const about = who?.name ?? str(p.name) ?? 'Someone';
  const kind = n.kind as NotificationKind;
  switch (kind) {
    case 'reply':
      return { kind, name: about, company: who?.company ?? null, title: `Replied: ${str(p.subject) ?? '(no subject)'}`, detail: 'Their campaign has stopped. Set a next step or move them to the CRM.', href: subjectLink, linkLabel: `Open ${about}` };
    case 'bounce':
      return { kind, name: about, company: who?.company ?? null, title: `Email bounced: ${str(p.subject) ?? '(no subject)'}`, detail: str(p.text), href: subjectLink, linkLabel: `Open ${about}` };
    case 'possible_bounce':
      return { kind, name: about, company: who?.company ?? null, title: `Possible bounce: ${str(p.subject) ?? '(no subject)'}`, detail: 'The notice did not say for certain. Check the address, then clear or confirm it on the contact.', href: subjectLink, linkLabel: `Open ${about}` };
    case 'compliance_alert':
      return { kind, name: about, company: who?.company ?? null, title: 'Emailed someone who must not be contacted', detail: str(p.text), href: subjectLink, linkLabel: subjectLink ? `Open ${about}` : '' };
    case 'next_step_suggestion': {
      const when = str(p.when);
      const how = p.kind === 'MEETING' ? 'Meeting' : ACTION_WORDS[String(p.how ?? '')] ?? null;
      const what = str(p.what) ?? how ?? 'Next step';
      const words = `${what}${how && how !== what ? ` (${how})` : ''}${when && isLocalDate(when) ? ` on ${formatLocalDate(when)}` : ''}`;
      const detail = n.resolution === 'accepted' ? 'You accepted it: it is the next step now.' : n.resolution === 'dismissed' ? 'You dismissed it. The next step stayed as it was.' : null;
      return {
        kind, name: about, company: who?.company ?? null, title: `${from} suggests a next step: ${words}`, detail, href: subjectLink, linkLabel: `Open ${about}`,
        suggestion: { id: n.id, resolution: n.resolution ?? null, mayAccept: !n.resolution && viewer?.role !== 'BIZ_OPS' },
      };
    }
    case 'call_flag': {
      const callId = str(p.callId);
      return { kind, name: from, company: null, title: str(p.text) ?? 'A call to look at', detail: null, href: callId ? `/calls/${callId}` : str(p.href), linkLabel: 'Open the call' };
    }
    case 'move_finished': {
      const moveId = str(p.moveId);
      const done = num(p.done), failed = num(p.failed);
      const title = failed ? `${plural(done, 'contact')} moved, ${failed} failed` : `${plural(done, 'contact')} moved`;
      return { kind, name: 'Move to CRM', company: null, title, detail: failed ? 'Open the move to see why and to retry.' : null, href: moveId ? `${COLD_CONTACT_BASE}/moves/${moveId}` : str(p.href), linkLabel: 'Open the move' };
    }
    case 'retention_warning': {
      const count = num(p.count);
      const due = str(p.firstDueOn);
      const ids = Array.isArray(p.contactIds) ? (p.contactIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const first = ids.map((id) => names.contacts.get(id)?.name).filter((x): x is string => Boolean(x));
      const listed = first.length ? `${first.slice(0, 2).join(', ')}${count > 2 ? ` and ${count - 2} more` : ''}. ` : '';
      return {
        kind, name: 'Cold outreach', company: null,
        title: `${plural(count, 'cold contact')} of yours will be removed${due && isLocalDate(due) ? ` from ${formatLocalDate(due, 'year')}` : ''} unless someone works them`,
        detail: `${listed}A call, a next step or a campaign keeps a contact.`,
        href: ids.length === 1 ? subjectHref(coldRef(ids[0])) : `${COLD_CONTACT_BASE}?owner=mine`, linkLabel: ids.length === 1 ? `Open ${first[0] ?? 'the contact'}` : 'Open your contacts',
      };
    }
    default:
      return { kind, name: about, company: who?.company ?? null, title: str(p.text) ?? 'Something to look at', detail: null, href: subjectLink ?? str(p.href), linkLabel: 'Open' };
  }
}

/** Names for a page of rows, in three reads. */
async function namesFor(rows: Row[]): Promise<Names> {
  const contactIds = new Set<string>();
  for (const r of rows) {
    if (r.sandboxContactId) contactIds.add(r.sandboxContactId);
    const ids = (r.payload as { contactIds?: unknown } | null)?.contactIds;
    if (r.kind === 'retention_warning' && Array.isArray(ids)) for (const id of ids.slice(0, 2)) if (typeof id === 'string') contactIds.add(id);
  }
  const personIds = [...new Set(rows.flatMap((r) => (r.personId ? [r.personId] : [])))];
  const userIds = [...new Set(rows.flatMap((r) => (r.fromUserId ? [r.fromUserId] : [])))];
  const [people, contacts, users] = await Promise.all([
    personIds.length ? prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, firstName: true, lastName: true, email: true, companyName: true } }) : [],
    contactIds.size ? prisma.sandboxContact.findMany({ where: { id: { in: [...contactIds] } }, select: { id: true, firstName: true, lastName: true, companyName: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
  ]);
  return {
    people: new Map(people.map((p) => [p.id, { name: cachedPersonName(p), company: p.companyName }])),
    contacts: new Map(contacts.map((c) => [c.id, { name: `${c.firstName} ${c.lastName}`.trim() || 'Removed contact', company: c.companyName }])),
    users: new Map(users.map((u) => [u.id, u.name])),
  };
}

/**
 * One page of the bell, newest first: CRM replies and Notification rows together. `cursor` is the
 * `next` of the page before.
 */
export async function listNotifications(user: Pick<SessionUser, 'id' | 'twentyMemberId' | 'role'>, cursor?: string | null, now = new Date()): Promise<{ through: string; next: string | null; items: BellItem[] }> {
  const after = parseKey(cursor);
  if (cursor && !after) throw new Error('Notification cursor is unavailable.');
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { notificationsReadAt: true } });
  const read = current.notificationsReadAt;
  const [touches, rows] = await Promise.all([
    prisma.touch.findMany({ where: { AND: [notificationScope(user), before(after)] }, include: { person: { select: { id: true, firstName: true, lastName: true, email: true, companyName: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PAGE + 1 }),
    prisma.notification.findMany({ where: { AND: [{ userId: user.id }, before(after)] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PAGE + 1 }),
  ]);
  const names = await namesFor(rows);
  const merged = [
    ...touches.map((t) => ({ key: { at: t.createdAt, id: t.id }, item: {
      id: t.id, kind: 'crm_reply' as const, name: t.person ? cachedPersonName(t.person) : 'Someone', company: t.person?.companyName ?? null, title: t.summary, detail: null,
      href: t.personId ? `/people/${t.personId}?tab=emails` : null, linkLabel: 'Open their emails', at: t.occurredAt.toISOString(), unread: !read || t.createdAt > read,
    } })),
    ...rows.map((n) => ({ key: { at: n.createdAt, id: n.id }, item: { id: n.id, ...bellWords(n, names, user), at: n.createdAt.toISOString(), unread: !n.readAt && (!read || n.createdAt > read) } })),
  ].sort((a, b) => newer(a.key, b.key));
  const page = merged.slice(0, PAGE);
  return { through: now.toISOString(), next: merged.length > PAGE ? keyOf(page[page.length - 1].key) : null, items: page.map((m) => m.item) };
}

/** "Mark read": everything up to `through` (the moment the list was opened) is read. */
export async function markNotificationsRead(userId: string, through: Date): Promise<void> {
  await prisma.user.updateMany({ where: { id: userId, OR: [{ notificationsReadAt: null }, { notificationsReadAt: { lt: through } }] }, data: { notificationsReadAt: through } });
  await prisma.notification.updateMany({ where: { userId, readAt: null, createdAt: { lte: through } }, data: { readAt: through } });
}
