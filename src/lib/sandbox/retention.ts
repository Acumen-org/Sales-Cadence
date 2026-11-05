import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { SYSTEM_ACTOR } from '../audit';
import { getSettings } from '../settings';
import { toE164 } from './normalize';
import { PII_CLEARED, removeContact } from './contacts';

/**
 * The nightly retention pass (plan section 13, decisions 10 and 13; cold outreach PLAN 8.5 and the
 * owner's decision of 5 Nov: never paused, no manual step):
 * - An ACTIVE contact with no activity for 180 days, or never worked 90 days after it arrived, is
 *   removed: personal data cleared, Bellwether reads `removed`. Every action counts as activity
 *   (N032): calls, forms, notes, emails, next steps set or done, steps done, claims, assignments,
 *   edits, undone moves; the contact's own lastActivityAt and anything a user did to it.
 * - Never removed: "Also in CRM" contacts (listed as Move to CRM needed, N075), and any contact with an
 *   open next step, a running enrollment, a post-call form waiting or a move in flight.
 * - The pass pages through every candidate, however many are kept (B214).
 * - Each night it records what it would remove in the next 30 days (RETENTION_FORECAST_KEY), shown
 *   read-only in Settings > Cold outreach, and warns owners a week ahead.
 * - A moved contact keeps its data for the undo window; an opted-out one keeps its tombstone and
 *   suppression hashes, its data going after the same 180 days, so Bellwether keeps reading opted_out.
 */

export const RETENTION_FORECAST_KEY = 'coldOutreachRetentionForecast';
export const FORECAST_DAYS = 30;
export const WARN_DAYS = 7;
const PAGE = 500;
const DAY = 86_400_000;

export type RetentionItem = { id: string; ownerId: string | null; podId: string | null; dueOn: string; basis: 'inactive' | 'never_worked'; lastActivityAt: string | null };
export type RetentionForecast = {
  at: string;
  horizonDays: number;
  /** Contacts that would be removed in the next `horizonDays`, soonest first (at most 1,000 listed). */
  total: number;
  items: RetentionItem[];
  /** Kept because they are also in the CRM: Move to CRM is what they need (N075). */
  moveToCrmNeeded: { count: number; ids: string[] };
  removedTonight: number;
};

/** The last activity of each contact, from every place one leaves a trace (N032). */
export async function lastActivityOf(ids: string[]): Promise<Map<string, Date | null>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<{ id: string; last: Date | null }[]>`
    SELECT c.id, GREATEST(
      c."lastActivityAt",
      (SELECT max(n."createdAt") FROM "SandboxNote" n WHERE n."sandboxContactId" = c.id),
      (SELECT max(COALESCE(l."startedAt", l."createdAt")) FROM "CallLog" l WHERE l."sandboxContactId" = c.id),
      (SELECT max(t."occurredAt") FROM "Touch" t WHERE t."sandboxContactId" = c.id),
      (SELECT max(GREATEST(na."createdAt", na."lastDoneAt")) FROM "NextAction" na WHERE na."sandboxContactId" = c.id),
      (SELECT max(k."completedAt") FROM "Task" k JOIN "Enrollment" e ON e.id = k."enrollmentId" WHERE e."sandboxContactId" = c.id AND k.state = 'DONE'),
      (SELECT max(a."createdAt") FROM "AuditLog" a WHERE a."entityType" = 'sandbox_contact' AND a."entityId" = c.id AND a."actorType" = 'USER')
    ) AS last
    FROM "SandboxContact" c WHERE c.id = ANY(${ids}::text[])`;
  return new Map(rows.map((r) => [r.id, r.last]));
}

/** Contacts retention may look at: active, not in the CRM, and with nothing open on them. */
const removable = (createdBefore: Date): Prisma.SandboxContactWhereInput => ({
  status: 'ACTIVE',
  createdAt: { lt: createdBefore },
  crmMatchPersonId: null,
  crmAutoPersonId: null,
  nextActions: { none: { state: 'OPEN' } },
  enrollments: { none: { status: { in: ['ACTIVE', 'PAUSED'] } } },
  calls: { none: { formDueAt: { not: null }, formDoneAt: null } },
});

const localDay = (d: Date) => d.toISOString().slice(0, 10);

export async function runSandboxRetention(now = new Date(), opts: { remove?: boolean } = {}): Promise<{ removed: number; forecast: number; moveToCrmNeeded: number; movedCleared: number; optedOutCleared: number }> {
  const { sandbox } = await getSettings();
  const remove = opts.remove !== false;
  const horizon = new Date(now.getTime() + FORECAST_DAYS * DAY);
  const shortest = Math.min(sandbox.retentionInactiveDays, sandbox.retentionUnworkedDays);
  // Nothing created later than this can fall due within the horizon.
  const createdBefore = new Date(horizon.getTime() - shortest * DAY);
  const items: RetentionItem[] = [];
  let removed = 0;
  let total = 0;
  let after: string | null = null;
  for (;;) {
    const page: { id: string; ownerId: string | null; podId: string | null; createdAt: Date }[] = await prisma.sandboxContact.findMany({
      where: { ...removable(createdBefore), ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, ownerId: true, podId: true, createdAt: true }, orderBy: { id: 'asc' }, take: PAGE,
    });
    if (!page.length) break;
    after = page[page.length - 1].id;
    const last = await lastActivityOf(page.map((c) => c.id));
    for (const c of page) {
      const lastAt = last.get(c.id) ?? null;
      const due = lastAt ? new Date(lastAt.getTime() + sandbox.retentionInactiveDays * DAY) : new Date(c.createdAt.getTime() + sandbox.retentionUnworkedDays * DAY);
      if (due > horizon) continue;
      if (due <= now && remove) {
        // Asked again just before: anything done to the contact since the page was read keeps it.
        const still = await prisma.sandboxContact.count({ where: { id: c.id, ...removable(createdBefore) } });
        const fresh = (await lastActivityOf([c.id])).get(c.id) ?? null;
        if (!still || (fresh?.getTime() ?? 0) !== (lastAt?.getTime() ?? 0)) continue;
        if ((await removeContact(c.id, SYSTEM_ACTOR, now, { reason: lastAt ? 'No activity for a long time (retention).' : 'Never worked (retention).' })).ok) removed++;
        continue;
      }
      total++;
      if (items.length < 1000) items.push({ id: c.id, ownerId: c.ownerId, podId: c.podId, dueOn: localDay(due), basis: lastAt ? 'inactive' : 'never_worked', lastActivityAt: lastAt?.toISOString() ?? null });
    }
  }
  items.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id));
  const flagged = await prisma.sandboxContact.findMany({ where: { status: 'ACTIVE', OR: [{ crmMatchPersonId: { not: null } }, { crmAutoPersonId: { not: null } }] }, select: { id: true }, orderBy: { id: 'asc' }, take: 200 });
  const flaggedCount = await prisma.sandboxContact.count({ where: { status: 'ACTIVE', OR: [{ crmMatchPersonId: { not: null } }, { crmAutoPersonId: { not: null } }] } });
  const forecast: RetentionForecast = { at: now.toISOString(), horizonDays: FORECAST_DAYS, total, items, moveToCrmNeeded: { count: flaggedCount, ids: flagged.map((f) => f.id) }, removedTonight: removed };
  await prisma.setting.upsert({ where: { key: RETENTION_FORECAST_KEY }, create: { key: RETENTION_FORECAST_KEY, value: forecast as unknown as Prisma.InputJsonValue }, update: { value: forecast as unknown as Prisma.InputJsonValue } });
  await warnOwners(items, now);

  let movedCleared = 0;
  let optedOutCleared = 0;
  if (remove) {
    const day = DAY;
    const inactiveBefore = new Date(now.getTime() - sandbox.retentionInactiveDays * day);
    // N062: a moved contact keeps its data until its own move's undo deadline, fixed when it moved;
    // lowering the setting later never takes undo away from moves already made.
    const expired = await prisma.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM "SandboxContact" c WHERE c.status = 'MOVED' AND c."piiClearedAt" IS NULL AND COALESCE(
        (SELECT max(i."undoUntil") FROM "SandboxMoveItem" i WHERE i."sandboxContactId" = c.id AND i.state = 'DONE'),
        c."movedAt" + make_interval(days => ${sandbox.undoDays}::int)
      ) < ${now}`;
    movedCleared = expired.length ? (await prisma.sandboxContact.updateMany({ where: { id: { in: expired.map((e) => e.id) }, status: 'MOVED', piiClearedAt: null }, data: { ...(PII_CLEARED as object), piiClearedAt: now } })).count : 0;
    optedOutCleared = (await prisma.sandboxContact.updateMany({ where: { status: 'OPTED_OUT', optedOutAt: { lt: inactiveBefore }, piiClearedAt: null }, data: { ...(PII_CLEARED as object), piiClearedAt: now } })).count;
    if (movedCleared || optedOutCleared) await prisma.sandboxNote.deleteMany({ where: { contact: { piiClearedAt: { not: null } } } });
  }
  return { removed, forecast: total, moveToCrmNeeded: flaggedCount, movedCleared, optedOutCleared };
}

/** The forecast as last recorded, for Settings > Cold outreach (read only). */
export async function retentionForecast(): Promise<RetentionForecast | null> {
  const row = await prisma.setting.findUnique({ where: { key: RETENTION_FORECAST_KEY } });
  return (row?.value as unknown as RetentionForecast) ?? null;
}

/** Owners hear a week ahead which of their contacts retention will remove: one notice each, replaced nightly. */
async function warnOwners(items: RetentionItem[], now: Date) {
  const soon = localDay(new Date(now.getTime() + WARN_DAYS * DAY));
  const byOwner = new Map<string, RetentionItem[]>();
  for (const i of items) if (i.ownerId && i.dueOn <= soon) byOwner.set(i.ownerId, [...(byOwner.get(i.ownerId) ?? []), i]);
  await prisma.notification.deleteMany({ where: { kind: 'retention_warning', readAt: null, ...(byOwner.size ? { userId: { notIn: [...byOwner.keys()] } } : {}) } });
  for (const [userId, list] of byOwner) {
    await prisma.notification.deleteMany({ where: { userId, kind: 'retention_warning', readAt: null } });
    await prisma.notification.create({ data: { userId, kind: 'retention_warning', payload: { count: list.length, firstDueOn: list[0].dueOn, contactIds: list.slice(0, 50).map((i) => i.id) } } });
  }
}

/** Once: the E.164 copy of every cached phone, so calls and pushes can match CRM people by number. */
export async function backfillPhoneE164(batch = 500): Promise<number> {
  let updated = 0;
  let after: string | null = null;
  for (let i = 0; i < 10_000; i++) {
    const rows: { id: string; phone: string | null; additionalPhone: string | null; phoneE164: string | null; additionalPhoneE164: string | null }[] = await prisma.personCache.findMany({
      where: { ...(after ? { id: { gt: after } } : {}), OR: [{ phone: { not: null }, phoneE164: null }, { additionalPhone: { not: null }, additionalPhoneE164: null }] },
      select: { id: true, phone: true, additionalPhone: true, phoneE164: true, additionalPhoneE164: true }, orderBy: { id: 'asc' }, take: batch,
    });
    if (!rows.length) break;
    for (const r of rows) {
      const phoneE164 = r.phoneE164 ?? toE164(r.phone);
      const additionalPhoneE164 = r.additionalPhoneE164 ?? toE164(r.additionalPhone);
      if (phoneE164 === r.phoneE164 && additionalPhoneE164 === r.additionalPhoneE164) continue;
      await prisma.personCache.update({ where: { id: r.id }, data: { phoneE164, additionalPhoneE164 } });
      updated++;
    }
    after = rows[rows.length - 1].id;
  }
  return updated;
}
