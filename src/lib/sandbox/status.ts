import { Prisma, type SandboxContact } from '@prisma/client';
import { databaseNow, prisma, type Tx } from '../db';
import { env } from '../env';
import { getTwentyConnection } from '../settings';
import { coldRef, subjectHref } from '../subject';
import { twentyPersonUrl } from '../twenty/urls';
import type { Contract } from './bellwether-api';

/**
 * What Bellwether reads back about each contact it pushed (contract 14.12). The status of a
 * Bellwether id comes from the sandbox contact that answers for it, or from a push that was
 * refused (already in the CRM, suppressed, or with contract 1.1 any other refusal); whichever
 * changed last decides.
 *
 * Contract 1.1 (PLAN 7.3) adds fields to each row and the status `refused` with its `reason`; a
 * request without X-Cadence-Contract: 1.1 gets exactly the v1 row, and never sees a refused one.
 */

export type BellwetherStatus = 'in_sandbox' | 'moved_to_crm' | 'already_in_crm' | 'opted_out' | 'removed' | 'not_found' | 'refused';

export type StatusRow = {
  bellwetherContactId: string;
  status: BellwetherStatus;
  cadenceContactId: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  campaignName: string | null;
  callCount: number;
  lastActivityAt: string | null;
  movedToCrmAt: string | null;
  crmPersonId: string | null;
  crmUrl: string | null;
  statusChangedAt: string;
};

/** Contract 1.1's row: v1's fields, then these, always present (null when they do not apply). */
export type StatusRowV11 = StatusRow & {
  /** The contact's page in Cadence (B176). */
  cadenceUrl: string | null;
  /** Who removed it (their name), when and why (B086); null unless the status is `removed`. */
  removedBy: string | null;
  removedAt: string | null;
  removedReason: string | null;
  /** An admin erased the person (N039); comes with status `opted_out`. */
  erasedAt: string | null;
  /** The address that bounced, and when (N040). */
  emailBounced: string | null;
  emailBouncedAt: string | null;
  /** A CRM person the push thought might be this contact (B143). */
  possibleCrmPersonId: string | null;
  /** The latest post-call outcome (the form's outcome key, e.g. not_interested) and when. */
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
  /** When Cadence last lifted an opt-out of this contact (D4); only while the status is not opted_out. */
  optOutLiftedAt: string | null;
  /** Status `refused`: the push's reason (invalid_field, do_not_contact, blocked_account, ...). */
  reason: string | null;
};

const V1_KEYS: (keyof StatusRow)[] = ['bellwetherContactId', 'status', 'cadenceContactId', 'ownerEmail', 'ownerName', 'campaignName', 'callCount', 'lastActivityAt', 'movedToCrmAt', 'crmPersonId', 'crmUrl', 'statusChangedAt'];

/** A row as a contract version reads it: v1 gets exactly v1's twelve fields. */
export function statusRowFor(row: StatusRowV11, contract: Contract): StatusRow | StatusRowV11 {
  if (contract === '1.1') return row;
  return Object.fromEntries(V1_KEYS.map((k) => [k, row[k]])) as StatusRow;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/** The contact's page in Cadence, as Bellwether links to it (B176). */
export const cadenceUrlOf = (contactId: string) => `${env().APP_URL.replace(/\/+$/, '')}${subjectHref(coldRef(contactId))}`;

/**
 * What a refusal matched on (BellwetherRefusal.matchedOn): a person's own details (email, linkedin,
 * phone_personal, bellwether_id, individual_crd, name_firm) or a line that may be shared
 * (phone_shared). Opting the CRM person out later flips only the first kind (N011).
 */
export type RefusalMatch = 'email' | 'linkedin' | 'phone_personal' | 'phone_shared' | 'bellwether_id' | 'individual_crd' | 'name_firm';
export const OWN_DETAIL_MATCHES: RefusalMatch[] = ['email', 'linkedin', 'phone_personal', 'bellwether_id', 'individual_crd', 'name_firm'];

/**
 * A push refused for a reason Bellwether must keep seeing: the time only moves when the status (or a
 * refused one's reason) changes, and it is the database's clock (B062). Inside the push's own
 * transaction when given one, so a check rolls it back with everything else.
 */
export async function recordRefusal(bellwetherContactId: string, status: 'already_in_crm' | 'opted_out' | 'refused', crmPersonId: string | null, opts: { tx?: Tx | typeof prisma; matchedOn?: RefusalMatch | null; reason?: string | null } = {}): Promise<void> {
  const tx = opts.tx ?? prisma;
  const matchedOn = opts.matchedOn ?? null;
  const reason = status === 'refused' ? opts.reason ?? null : null;
  const existing = await tx.bellwetherRefusal.findUnique({ where: { bellwetherContactId } });
  const stamp = await databaseNow(tx);
  if (!existing) {
    await tx.bellwetherRefusal.create({ data: { bellwetherContactId, status, crmPersonId, matchedOn, reason, statusChangedAt: stamp } });
    return;
  }
  const same = existing.status === status && (status !== 'refused' || existing.reason === reason);
  await tx.bellwetherRefusal.update({ where: { bellwetherContactId }, data: same ? { crmPersonId: crmPersonId ?? existing.crmPersonId, matchedOn: matchedOn ?? existing.matchedOn } : { status, crmPersonId, matchedOn, reason, statusChangedAt: stamp } });
}

/** Opted out wins: a contact with an opt-out on it reads opted_out whatever else happened to it (N026). */
export function statusOfContact(c: Pick<SandboxContact, 'status' | 'optedOutAt' | 'crmMatchPersonId'>): BellwetherStatus {
  if (c.optedOutAt || c.status === 'OPTED_OUT') return 'opted_out';
  // Twenty gained the person after the push (the daily check, crm-check.ts).
  if (c.status === 'ACTIVE') return c.crmMatchPersonId ? 'already_in_crm' : 'in_sandbox';
  if (c.status === 'MOVED') return 'moved_to_crm';
  return 'removed';
}

const NO_V11 = { cadenceUrl: null, removedBy: null, removedAt: null, removedReason: null, erasedAt: null, emailBounced: null, emailBouncedAt: null, possibleCrmPersonId: null, lastOutcome: null, lastOutcomeAt: null, optOutLiftedAt: null, reason: null };

/**
 * The status of each id, in the order asked; an id Cadence never received is not_found. Contract
 * 1.1's rows carry its fields; v1's are exactly the v1 rows, and a refusal only 1.1 reports (refused)
 * is not there for them.
 */
export async function statusByIds(ids: string[], contract: Contract = '1'): Promise<Array<StatusRow | StatusRowV11>> {
  if (!ids.length) return [];
  const conn = await getTwentyConnection();
  const [contacts, refusals, now] = await Promise.all([
    prisma.sandboxContact.findMany({ where: { OR: [{ bellwetherContactId: { in: ids } }, { bellwetherAliases: { hasSome: ids } }] }, include: { owner: { select: { email: true, name: true, active: true } } } }),
    prisma.bellwetherRefusal.findMany({ where: { bellwetherContactId: { in: ids }, ...(contract === '1' ? { status: { not: 'refused' } } : {}) } }),
    databaseNow(),
  ]);
  const contactIds = contacts.map((c) => c.id);
  const [calls, enrollments, bounces, removers] = contactIds.length
    ? await Promise.all([
        prisma.callLog.groupBy({ by: ['sandboxContactId'], where: { sandboxContactId: { in: contactIds } }, _count: { _all: true } }),
        prisma.enrollment.findMany({ where: { sandboxContactId: { in: contactIds }, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { sandboxContactId: true, campaign: { select: { name: true } } } }),
        prisma.sandboxEmail.groupBy({ by: ['sandboxContactId'], where: { sandboxContactId: { in: contacts.filter((c) => c.badEmail).map((c) => c.id) }, kind: 'BOUNCE' }, _max: { at: true } }),
        prisma.user.findMany({ where: { id: { in: contacts.flatMap((c) => (c.removedById ? [c.removedById] : [])) } }, select: { id: true, name: true } }),
      ])
    : [[], [], [], []];
  const callsBy = new Map(calls.map((c) => [c.sandboxContactId, c._count._all]));
  const campaignBy = new Map(enrollments.map((e) => [e.sandboxContactId, e.campaign?.name ?? null]));
  const bounceBy = new Map(bounces.map((b) => [b.sandboxContactId, b._max.at]));
  // N040: a bounce confirmed from a possible bounce (or marked by a skip) has no bounce email of its
  // own: its time is when it was confirmed or recorded.
  const unbounced = contacts.filter((c) => c.badEmail && !bounceBy.get(c.id)).map((c) => c.id);
  if (unbounced.length) {
    const marked = await prisma.auditLog.groupBy({ by: ['entityId'], where: { entityType: 'sandbox_contact', entityId: { in: unbounced }, action: { in: ['possible_bounce_confirmed', 'email_bounced'] } }, _max: { createdAt: true } });
    for (const m of marked) if (m._max.createdAt) bounceBy.set(m.entityId, m._max.createdAt);
    for (const c of contacts) if (unbounced.includes(c.id) && !bounceBy.get(c.id)) bounceBy.set(c.id, c.statusChangedAt);
  }
  const removerBy = new Map(removers.map((u) => [u.id, u.name]));
  const refusalBy = new Map(refusals.map((r) => [r.bellwetherContactId, r]));
  const personIds = [...new Set([...contacts.flatMap((c) => [c.twentyPersonId, c.crmMatchPersonId]), ...refusals.map((r) => r.crmPersonId)].filter((id): id is string => Boolean(id)))];
  const people = personIds.length ? await prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, ownerMemberId: true, optOutLiftedAt: true } }) : [];
  const memberBy = new Map(people.map((p) => [p.id, p.ownerMemberId]));
  const liftBy = new Map(people.map((p) => [p.id, p.optOutLiftedAt]));
  const members = [...new Set(people.flatMap((p) => (p.ownerMemberId ? [p.ownerMemberId] : [])))];
  const memberUsers = members.length ? await prisma.user.findMany({ where: { twentyMemberId: { in: members } }, select: { twentyMemberId: true, email: true, name: true } }) : [];
  const ownerOfPerson = (personId: string | null | undefined) => {
    const member = personId ? memberBy.get(personId) : null;
    const u = member ? memberUsers.find((x) => x.twentyMemberId === member) : null;
    return u ? { email: u.email, name: u.name } : null;
  };
  const out: StatusRowV11[] = [];
  for (const id of ids) {
    const answering = contacts
      .filter((c) => c.bellwetherContactId === id || c.bellwetherAliases.includes(id))
      .sort((a, b) => b.statusChangedAt.getTime() - a.statusChangedAt.getTime())[0];
    const refusal = refusalBy.get(id);
    if (answering && (!refusal || answering.statusChangedAt >= refusal.statusChangedAt)) {
      const status = statusOfContact(answering);
      const inCrm = status === 'moved_to_crm' || status === 'already_in_crm' || (answering.status === 'MOVED');
      const crmPerson = answering.status === 'MOVED' ? answering.twentyPersonId : answering.crmMatchPersonId;
      // A rep whose access was removed owns nothing (N017): Bellwether shows the contact unclaimed.
      const owner = inCrm ? ownerOfPerson(crmPerson) : answering.owner?.active ? answering.owner : null;
      const removed = status === 'removed';
      out.push({
        bellwetherContactId: id, status, cadenceContactId: answering.id, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null,
        campaignName: campaignBy.get(answering.id) ?? null, callCount: callsBy.get(answering.id) ?? 0, lastActivityAt: iso(answering.lastActivityAt),
        movedToCrmAt: answering.status === 'MOVED' ? iso(answering.movedAt) : null,
        crmPersonId: inCrm ? crmPerson : null, crmUrl: inCrm && crmPerson ? twentyPersonUrl(conn.baseUrl, crmPerson) : null,
        statusChangedAt: iso(answering.statusChangedAt)!,
        cadenceUrl: cadenceUrlOf(answering.id),
        removedBy: removed && answering.removedById ? removerBy.get(answering.removedById) ?? null : null,
        removedAt: removed ? iso(answering.piiClearedAt ?? answering.statusChangedAt) : null,
        removedReason: removed ? answering.removedReason : null,
        erasedAt: iso(answering.erasedAt),
        emailBounced: answering.badEmail && answering.email ? answering.email : null,
        emailBouncedAt: answering.badEmail && answering.email ? iso(bounceBy.get(answering.id) ?? null) : null,
        possibleCrmPersonId: answering.possibleCrmPersonId,
        lastOutcome: answering.lastOutcome, lastOutcomeAt: iso(answering.lastOutcomeAt),
        // S4: a lift is sent once the contact no longer reads opted_out; Bellwether then lifts only what that opt-out wrote.
        optOutLiftedAt: status === 'opted_out' ? null : iso(answering.optOutLiftedAt),
        reason: null,
      });
      continue;
    }
    if (refusal) {
      const owner = ownerOfPerson(refusal.crmPersonId);
      const status = refusal.status as BellwetherStatus;
      out.push({
        bellwetherContactId: id, status, cadenceContactId: null, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null,
        campaignName: null, callCount: 0, lastActivityAt: null, movedToCrmAt: null, crmPersonId: refusal.crmPersonId,
        crmUrl: refusal.crmPersonId ? twentyPersonUrl(conn.baseUrl, refusal.crmPersonId) : null, statusChangedAt: iso(refusal.statusChangedAt)!,
        ...NO_V11,
        optOutLiftedAt: status !== 'opted_out' && refusal.crmPersonId ? iso(liftBy.get(refusal.crmPersonId) ?? null) : null,
        reason: status === 'refused' ? refusal.reason : null,
      });
      continue;
    }
    out.push({ bellwetherContactId: id, status: 'not_found', cadenceContactId: null, ownerEmail: null, ownerName: null, campaignName: null, callCount: 0, lastActivityAt: null, movedToCrmAt: null, crmPersonId: null, crmUrl: null, statusChangedAt: iso(now)!, ...NO_V11 });
  }
  return out.map((row) => statusRowFor(row, contract));
}

type Cursor = { at: string; key: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(raw: string | null | undefined): Cursor | null | 'invalid' {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    return typeof c.at === 'string' && typeof c.key === 'string' && !Number.isNaN(Date.parse(c.at)) ? c : 'invalid';
  } catch { return 'invalid'; }
}

/**
 * Every contact ever pushed whose status changed at or after `since`, oldest change first, `limit`
 * at a time. Follow nextCursor until it is null. A v1 reader never sees a refusal only 1.1 reports.
 */
export async function statusChangedSince(since: Date, cursor: Cursor | null, limit: number, contract: Contract = '1'): Promise<{ results: Array<StatusRow | StatusRowV11>; nextCursor: string | null }> {
  const after = cursor ? Prisma.sql`AND (s.at > ${new Date(cursor.at)} OR (s.at = ${new Date(cursor.at)} AND s.key > ${cursor.key}))` : Prisma.empty;
  const refusals = contract === '1' ? Prisma.sql`WHERE r.status <> 'refused'` : Prisma.empty;
  // Prisma keeps DateTime as UTC in timestamp columns; read them as UTC so the session's zone never shifts them.
  const keys = await prisma.$queryRaw<{ key: string; at: Date }[]>`
    SELECT s.key, s.at FROM (
      SELECT u.key, max(u.at) AS at FROM (
        SELECT c."bellwetherContactId" AS key, c."statusChangedAt" AT TIME ZONE 'UTC' AS at FROM "SandboxContact" c WHERE c."bellwetherContactId" IS NOT NULL
        UNION ALL
        SELECT a.alias AS key, c."statusChangedAt" AT TIME ZONE 'UTC' AS at FROM "SandboxContact" c CROSS JOIN LATERAL unnest(c."bellwetherAliases") AS a(alias)
        UNION ALL
        SELECT r."bellwetherContactId" AS key, r."statusChangedAt" AT TIME ZONE 'UTC' AS at FROM "BellwetherRefusal" r ${refusals}
      ) u GROUP BY u.key
    ) s
    WHERE s.at >= ${since} ${after}
    ORDER BY s.at ASC, s.key ASC
    LIMIT ${limit + 1}`;
  const page = keys.slice(0, limit);
  const rows = await statusByIds(page.map((k) => k.key), contract);
  const last = page[page.length - 1];
  return { results: rows, nextCursor: keys.length > limit && last ? encodeCursor({ at: last.at.toISOString(), key: last.key }) : null };
}
