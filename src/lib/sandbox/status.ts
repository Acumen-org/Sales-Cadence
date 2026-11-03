import { Prisma, type SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { getTwentyConnection } from '../settings';
import { twentyPersonUrl } from '../twenty/urls';

/**
 * What Bellwether reads back about each contact it pushed (contract 14.12). The status of a
 * Bellwether id comes from the sandbox contact that answers for it, or from a push that was
 * refused (already in the CRM, or suppressed); whichever changed last decides.
 */

export type BellwetherStatus = 'in_sandbox' | 'moved_to_crm' | 'already_in_crm' | 'opted_out' | 'removed' | 'not_found';

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

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/** A push refused for a reason Bellwether must keep seeing: the time only moves when the status changes. */
export async function recordRefusal(bellwetherContactId: string, status: 'already_in_crm' | 'opted_out', crmPersonId: string | null, now = new Date()): Promise<void> {
  const existing = await prisma.bellwetherRefusal.findUnique({ where: { bellwetherContactId } });
  if (!existing) {
    await prisma.bellwetherRefusal.create({ data: { bellwetherContactId, status, crmPersonId, statusChangedAt: now } });
    return;
  }
  await prisma.bellwetherRefusal.update({ where: { bellwetherContactId }, data: existing.status === status ? { crmPersonId: crmPersonId ?? existing.crmPersonId } : { status, crmPersonId, statusChangedAt: now } });
}

export function statusOfContact(c: Pick<SandboxContact, 'status' | 'optedOutAt'>): BellwetherStatus {
  if (c.status === 'ACTIVE') return 'in_sandbox';
  if (c.status === 'MOVED') return c.optedOutAt ? 'opted_out' : 'moved_to_crm';
  if (c.status === 'OPTED_OUT') return 'opted_out';
  return 'removed';
}

async function ownerFromMember(memberId: string | null | undefined): Promise<{ email: string; name: string } | null> {
  if (!memberId) return null;
  return prisma.user.findFirst({ where: { twentyMemberId: memberId }, select: { email: true, name: true } });
}

/** The status of each id, in the order asked; an id Cadence never received is not_found. */
export async function statusByIds(ids: string[]): Promise<StatusRow[]> {
  if (!ids.length) return [];
  const conn = await getTwentyConnection();
  const [contacts, refusals] = await Promise.all([
    prisma.sandboxContact.findMany({ where: { OR: [{ bellwetherContactId: { in: ids } }, { bellwetherAliases: { hasSome: ids } }] }, include: { owner: { select: { email: true, name: true } } } }),
    prisma.bellwetherRefusal.findMany({ where: { bellwetherContactId: { in: ids } } }),
  ]);
  const contactIds = contacts.map((c) => c.id);
  const [calls, enrollments] = contactIds.length
    ? await Promise.all([
        prisma.callLog.groupBy({ by: ['sandboxContactId'], where: { sandboxContactId: { in: contactIds } }, _count: { _all: true } }),
        prisma.enrollment.findMany({ where: { sandboxContactId: { in: contactIds }, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { sandboxContactId: true, campaign: { select: { name: true } } } }),
      ])
    : [[], []];
  const callsBy = new Map(calls.map((c) => [c.sandboxContactId, c._count._all]));
  const campaignBy = new Map(enrollments.map((e) => [e.sandboxContactId, e.campaign?.name ?? null]));
  const refusalBy = new Map(refusals.map((r) => [r.bellwetherContactId, r]));
  const personIds = [...new Set([...contacts.map((c) => c.twentyPersonId), ...refusals.map((r) => r.crmPersonId)].filter((id): id is string => Boolean(id)))];
  const people = personIds.length ? await prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, ownerMemberId: true } }) : [];
  const memberBy = new Map(people.map((p) => [p.id, p.ownerMemberId]));
  const out: StatusRow[] = [];
  for (const id of ids) {
    const answering = contacts
      .filter((c) => c.bellwetherContactId === id || c.bellwetherAliases.includes(id))
      .sort((a, b) => b.statusChangedAt.getTime() - a.statusChangedAt.getTime())[0];
    const refusal = refusalBy.get(id);
    if (answering && (!refusal || answering.statusChangedAt >= refusal.statusChangedAt)) {
      const status = statusOfContact(answering);
      const inCrm = status === 'moved_to_crm' || (answering.status === 'MOVED');
      const owner = inCrm ? await ownerFromMember(answering.twentyPersonId ? memberBy.get(answering.twentyPersonId) : null) : answering.owner;
      out.push({
        bellwetherContactId: id, status, cadenceContactId: answering.id, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null,
        campaignName: campaignBy.get(answering.id) ?? null, callCount: callsBy.get(answering.id) ?? 0, lastActivityAt: iso(answering.lastActivityAt),
        movedToCrmAt: answering.status === 'MOVED' ? iso(answering.movedAt) : null,
        crmPersonId: inCrm ? answering.twentyPersonId : null, crmUrl: inCrm && answering.twentyPersonId ? twentyPersonUrl(conn.baseUrl, answering.twentyPersonId) : null,
        statusChangedAt: iso(answering.statusChangedAt)!,
      });
      continue;
    }
    if (refusal) {
      const owner = refusal.crmPersonId ? await ownerFromMember(memberBy.get(refusal.crmPersonId)) : null;
      out.push({
        bellwetherContactId: id, status: refusal.status as BellwetherStatus, cadenceContactId: null, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null,
        campaignName: null, callCount: 0, lastActivityAt: null, movedToCrmAt: null, crmPersonId: refusal.crmPersonId,
        crmUrl: refusal.crmPersonId ? twentyPersonUrl(conn.baseUrl, refusal.crmPersonId) : null, statusChangedAt: iso(refusal.statusChangedAt)!,
      });
      continue;
    }
    out.push({ bellwetherContactId: id, status: 'not_found', cadenceContactId: null, ownerEmail: null, ownerName: null, campaignName: null, callCount: 0, lastActivityAt: null, movedToCrmAt: null, crmPersonId: null, crmUrl: null, statusChangedAt: iso(new Date())! });
  }
  return out;
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
 * at a time. Follow nextCursor until it is null.
 */
export async function statusChangedSince(since: Date, cursor: Cursor | null, limit: number): Promise<{ results: StatusRow[]; nextCursor: string | null }> {
  const after = cursor ? Prisma.sql`AND (s.at > ${new Date(cursor.at)} OR (s.at = ${new Date(cursor.at)} AND s.key > ${cursor.key}))` : Prisma.empty;
  const keys = await prisma.$queryRaw<{ key: string; at: Date }[]>`
    SELECT s.key, s.at FROM (
      SELECT u.key, max(u.at) AS at FROM (
        SELECT c."bellwetherContactId" AS key, c."statusChangedAt" AS at FROM "SandboxContact" c WHERE c."bellwetherContactId" IS NOT NULL
        UNION ALL
        SELECT a.alias AS key, c."statusChangedAt" AS at FROM "SandboxContact" c CROSS JOIN LATERAL unnest(c."bellwetherAliases") AS a(alias)
        UNION ALL
        SELECT r."bellwetherContactId" AS key, r."statusChangedAt" AS at FROM "BellwetherRefusal" r
      ) u GROUP BY u.key
    ) s
    WHERE s.at >= ${since} ${after}
    ORDER BY s.at ASC, s.key ASC
    LIMIT ${limit + 1}`;
  const page = keys.slice(0, limit);
  const rows = await statusByIds(page.map((k) => k.key));
  const last = page[page.length - 1];
  return { results: rows, nextCursor: keys.length > limit && last ? encodeCursor({ at: last.at.toISOString(), key: last.key }) : null };
}
