import { prisma } from '../db';
import { SYSTEM_ACTOR } from '../audit';
import { getSettings } from '../settings';
import { toE164 } from './normalize';
import { PII_CLEARED, removeContact } from './contacts';

/**
 * The nightly retention pass (plan section 13, decisions 10 and 13):
 * - ACTIVE contacts nobody worked for 180 days, or never worked 90 days after they arrived, are
 *   removed: personal data cleared, Bellwether reads `removed`.
 * - A moved contact keeps its data for the one-year undo window; after it only ids and dates stay.
 * - An opted-out contact keeps its tombstone and suppression hashes; its data goes after the same
 *   180 days, so Bellwether keeps reading `opted_out`.
 */
export async function runSandboxRetention(now = new Date()): Promise<{ removed: number; movedCleared: number; optedOutCleared: number }> {
  const { sandbox } = await getSettings();
  const day = 86_400_000;
  const inactiveBefore = new Date(now.getTime() - sandbox.retentionInactiveDays * day);
  const unworkedBefore = new Date(now.getTime() - sandbox.retentionUnworkedDays * day);
  const candidates = await prisma.sandboxContact.findMany({
    where: { status: 'ACTIVE', OR: [{ lastActivityAt: { lt: inactiveBefore } }, { lastActivityAt: null, createdAt: { lt: unworkedBefore } }] },
    select: { id: true, lastActivityAt: true },
    take: 500,
  });
  let removed = 0;
  for (const c of candidates) {
    // Work in a running campaign, a step done or a next action still open counts as activity.
    const recentStep = await prisma.task.findFirst({ where: { enrollment: { sandboxContactId: c.id }, OR: [{ state: 'PENDING' }, { completedAt: { gte: c.lastActivityAt ? inactiveBefore : unworkedBefore } }] }, select: { id: true } });
    const openNext = await prisma.nextAction.count({ where: { sandboxContactId: c.id, personId: null, state: 'OPEN' } });
    if (recentStep || openNext) continue;
    if ((await removeContact(c.id, SYSTEM_ACTOR, now)).ok) removed++;
  }
  const movedBefore = new Date(now.getTime() - sandbox.undoDays * day);
  const moved = await prisma.sandboxContact.updateMany({ where: { status: 'MOVED', movedAt: { lt: movedBefore }, piiClearedAt: null }, data: { ...(PII_CLEARED as object), piiClearedAt: now } });
  const optedOut = await prisma.sandboxContact.updateMany({ where: { status: 'OPTED_OUT', optedOutAt: { lt: inactiveBefore }, piiClearedAt: null }, data: { ...(PII_CLEARED as object), piiClearedAt: now } });
  if (moved.count || optedOut.count) await prisma.sandboxNote.deleteMany({ where: { contact: { piiClearedAt: { not: null } } } });
  return { removed, movedCleared: moved.count, optedOutCleared: optedOut.count };
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
