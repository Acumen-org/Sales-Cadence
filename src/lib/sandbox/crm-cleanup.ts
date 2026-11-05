import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR, type AuditActor } from '../audit';
import { getSettings } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import { personFullName, type TwentyPerson } from '../twenty/types';
import { markPersonDeleted } from '../person-cache';

/**
 * What's in the sandbox stays in the sandbox (plan 8.9). Twenty's mail and calendar sync creates a
 * person for anyone a rep emails or meets, sandbox contacts included. Every five minutes this job
 * finds those people and soft-deletes the ones nobody has worked, so they stay restorable from
 * Twenty's trash. A person someone did work is left alone and flagged on the sandbox contact.
 *
 * A person is a candidate only when all of these hold:
 * - Twenty says it was created by EMAIL or CALENDAR (never MANUAL, IMPORT, API or by Cadence);
 * - its email or an additional email matches a sandbox contact that is not MOVED, and no MOVED one;
 * - it was created after that sandbox contact.
 * It is removed only when nobody touched it (see `keepReasons`).
 */

export const AUTO_SOURCES = ['EMAIL', 'CALENDAR'] as const;
/** The sync's own writes right after it creates a person (avatar, a second message) stay inside this. */
export const SYNC_MARGIN_MS = 10 * 60_000;
export const CLEANUP_EVERY_MS = 5 * 60_000;
/** Twenty calls are paced: at most this many people are looked at per run. */
export const PEOPLE_PER_RUN = 50;

export const REMOVED_ACTION = 'crm_auto_person_removed';
export const DRY_RUN_ACTION = 'crm_auto_person_would_remove';
export const KEPT_ACTION = 'crm_auto_person_kept';

export type KeepReason = 'edited' | 'notes' | 'tasks' | 'opportunities' | 'cadence_campaign' | 'cadence_enrollment' | 'cadence_work' | 'cadence_move';

export type CleanupStats = { ran: boolean; reason?: string; checked: number; removed: number; kept: number; dryRun: number; skipped: number; errors: number };

type Match = { personId: string; contactId: string; status: string; contactCreatedAt: Date };

const isAutoSource = (s: string | null | undefined) => AUTO_SOURCES.includes(String(s ?? '').toUpperCase() as (typeof AUTO_SOURCES)[number]);
const madeByCadence = (p: Pick<TwentyPerson, 'createdByName' | 'raw'>) => (p.createdByName ?? '').trim().toLowerCase() === 'cadence' || Boolean((p.raw as { cadenceSandboxId?: unknown } | undefined)?.cadenceSandboxId);

/**
 * Whether a person in Cadence's copy of the CRM is one Twenty's mail or calendar sync made for this
 * cold contact: auto-created (not by Cadence), after the contact, and not one the cleanup kept
 * because someone worked it. Mail with such a person belongs to the cold contact (N028).
 */
export function autoCreatedFor(p: { id: string; createdBySource: string | null; createdByName: string | null; raw: unknown }, contact: { createdAt: Date; crmAutoPersonId: string | null; crmMatchPersonId: string | null }): boolean {
  if (!isAutoSource(p.createdBySource) || madeByCadence({ createdByName: p.createdByName, raw: p.raw as TwentyPerson['raw'] })) return false;
  if (p.id === contact.crmAutoPersonId || p.id === contact.crmMatchPersonId) return false;
  const created = Date.parse(String((p.raw as { createdAt?: unknown } | null)?.createdAt ?? ''));
  return !Number.isFinite(created) || created > contact.createdAt.getTime();
}

/**
 * Cadence's copy of Twenty, joined to the sandbox on every address either side holds. The cache
 * follows Twenty within the sync interval; each hit is read live from Twenty before anything happens.
 */
async function findMatches(): Promise<Match[]> {
  return prisma.$queryRaw<Match[]>`
    SELECT p.id AS "personId", c.id AS "contactId", c.status::text AS status, c."createdAt" AS "contactCreatedAt"
    FROM "PersonCache" p
    JOIN "SandboxContact" c
      ON array_remove(array_append(ARRAY(SELECT lower(x) FROM unnest(c."additionalEmails") x), lower(c.email)), NULL)
      && array_remove(array_append(ARRAY(SELECT lower(x) FROM unnest(p."additionalEmails") x), lower(p.email)), NULL)
    WHERE p."deletedAt" IS NULL
      AND upper(coalesce(p."createdBySource", '')) IN ('EMAIL', 'CALENDAR')
    ORDER BY p.id, c."createdAt"`;
}

/** Why a person has to stay: anything a human or Cadence did beyond the synced mail and meetings. */
export async function keepReasons(client: TwentyClient, person: TwentyPerson): Promise<KeepReason[]> {
  const reasons: KeepReason[] = [];
  const created = Date.parse(person.createdAt);
  const updated = Date.parse(person.updatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated - created > SYNC_MARGIN_MS) reasons.push('edited');
  const [notes, tasks, opportunities] = await Promise.all([
    client.listNotes({ personId: person.id, limit: 1 }),
    client.listTasks({ personId: person.id, limit: 1 }),
    client.listOpportunities({ personId: person.id, limit: 1 }),
  ]);
  if (notes.items.length) reasons.push('notes');
  if (tasks.items.length) reasons.push('tasks');
  if (opportunities.items.length) reasons.push('opportunities');
  const id = person.id;
  const [campaigns, enrollments, nextActions, calls, meetings, moveItems, movedContacts] = await Promise.all([
    prisma.campaign.count({ where: { personIds: { has: id } } }),
    prisma.enrollment.count({ where: { personId: id } }),
    prisma.nextAction.count({ where: { personId: id } }),
    prisma.callLog.count({ where: { personId: id } }),
    prisma.meetingAttendee.count({ where: { personId: id } }),
    prisma.sandboxMoveItem.count({ where: { OR: [{ twentyPersonId: id }, { attachPersonId: id }] } }),
    prisma.sandboxContact.count({ where: { twentyPersonId: id } }),
  ]);
  if (campaigns) reasons.push('cadence_campaign');
  if (enrollments) reasons.push('cadence_enrollment');
  if (nextActions || calls || meetings) reasons.push('cadence_work');
  if (moveItems || movedContacts) reasons.push('cadence_move');
  return reasons;
}

/** One run. Does nothing while the switch in Settings > Sandbox is off; in dry run it only logs. */
export async function cleanupSandboxCrmPeople(opts: { actor?: AuditActor; limit?: number; client?: TwentyClient } = {}): Promise<CleanupStats> {
  const stats: CleanupStats = { ran: false, checked: 0, removed: 0, kept: 0, dryRun: 0, skipped: 0, errors: 0 };
  const settings = await getSettings();
  if (!settings.sandbox.cleanupAutoCreated) return { ...stats, reason: 'The cleanup is switched off in Settings > Sandbox.' };
  const client = opts.client ?? (await getTwentyClient());
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const dryRun = client.kind === 'dry-run';
  stats.ran = true;

  const byPerson = new Map<string, Match[]>();
  for (const m of await findMatches()) byPerson.set(m.personId, [...(byPerson.get(m.personId) ?? []), m]);
  if (!byPerson.size) return stats;

  // Already flagged (kept) or already logged as a dry-run removal: settled, not read again.
  const ids = [...byPerson.keys()];
  const [flagged, dryLogged] = await Promise.all([
    prisma.sandboxContact.findMany({ where: { crmAutoPersonId: { in: ids } }, select: { crmAutoPersonId: true } }),
    dryRun ? prisma.auditLog.findMany({ where: { action: DRY_RUN_ACTION, entityType: 'person', entityId: { in: ids } }, select: { entityId: true } }) : Promise.resolve([]),
  ]);
  const settled = new Set([...flagged.map((f) => f.crmAutoPersonId!), ...dryLogged.map((d) => d.entityId)]);

  for (const [personId, matches] of byPerson) {
    if (stats.checked >= (opts.limit ?? PEOPLE_PER_RUN)) break;
    if (settled.has(personId)) continue;
    // A MOVED contact with this address: the real person is in the CRM already. Not ours to judge.
    if (matches.some((m) => m.status === 'MOVED')) { stats.skipped++; continue; }
    stats.checked++;
    try {
      const person = await client.getPerson(personId);
      if (!person || person.deletedAt) { stats.skipped++; continue; }
      if (!isAutoSource(person.createdBySource) || madeByCadence(person)) { stats.skipped++; continue; }
      const created = Date.parse(person.createdAt);
      const contact = matches.find((m) => m.contactCreatedAt.getTime() < created);
      if (!contact) { stats.skipped++; continue; }
      const source = String(person.createdBySource).toUpperCase();
      const reasons = await keepReasons(client, person);
      const details = { personId, name: personFullName(person), email: person.email, source, sandboxContactId: contact.contactId };

      if (reasons.length) {
        await prisma.sandboxContact.update({ where: { id: contact.contactId }, data: { crmAutoPersonId: personId, crmAutoSource: source, crmAutoFlaggedAt: new Date() } });
        await logAudit({ entityType: 'sandbox_contact', entityId: contact.contactId, action: KEPT_ACTION, actor, details: { ...details, reasons } });
        stats.kept++;
        continue;
      }
      if (dryRun) {
        await logAudit({ entityType: 'person', entityId: personId, action: DRY_RUN_ACTION, actor, details: { ...details, dryRun: true } });
        stats.dryRun++;
        continue;
      }
      await client.deletePerson(personId);
      await markPersonDeleted(personId);
      await logAudit({ entityType: 'person', entityId: personId, action: REMOVED_ACTION, actor, details });
      stats.removed++;
    } catch (error) {
      stats.errors++;
      console.warn('[sandbox crm cleanup]', personId, error instanceof Error ? error.message : error);
    }
  }
  return stats;
}

/** For Settings: how many people the cleanup has removed, ever and in the last 7 days. */
export async function cleanupCounts(now = new Date()): Promise<{ total: number; week: number; kept: number }> {
  const week = new Date(now.getTime() - 7 * 86_400_000);
  const [total, recent, kept] = await Promise.all([
    prisma.auditLog.count({ where: { action: REMOVED_ACTION } }),
    prisma.auditLog.count({ where: { action: REMOVED_ACTION, createdAt: { gte: week } } }),
    prisma.sandboxContact.count({ where: { crmAutoPersonId: { not: null } } }),
  ]);
  return { total, week: recent, kept };
}
