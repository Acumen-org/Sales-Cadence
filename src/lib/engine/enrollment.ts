import type { Enrollment, EnrollmentStatus } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { diffDays, isLocalDate, localDateToInstant, todayIn, type LocalDate } from '../dates';
import { cachedPersonName, ensurePeopleCached } from '../person-cache';
import { getSettings } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import type { TwentyPerson } from '../twenty/types';
import { findDateWithCapacity, reserve, type DayLoad } from './caps';
import { nextWorkingDay } from './clock';
import { WORKSPACE_TIMEZONE } from '../workspace';
import { advanceEnrollment, cancelOpenTasks, isUniqueViolation, syncCancelled, type EngineContext } from './tasks';
import { loadSyncTasks, syncTaskRescheduled, syncTaskResolved, syncTasksCreated } from './sync-out';

export const OCCUPYING_STATUSES: EnrollmentStatus[] = ['ACTIVE', 'PAUSED'];

export type AssignmentSpec =
  | { mode: 'OWNER'; foUserIds?: string[] }
  | { mode: 'ROUND_ROBIN'; foUserIds?: string[] }
  | { mode: 'FIXED'; foUserId: string };

export type EnrollRequest = {
  personIds: string[];
  sequenceId: string;
  podId: string;
  campaignId?: string | null;
  /** YYYY-MM-DD; rolled to the next working day. */
  startDate: LocalDate;
  assignment: AssignmentSpec;
  /** New enrollments started per FO per working day. Null = no ramp. */
  dailyRampPerFo?: number | null;
  actor: AuditActor;
};

export type EnrollConflictReason = 'not_found' | 'deleted' | 'dnd' | 'opted_out' | 'already_active' | 'no_fo' | 'duplicate' | 'invalid_start';

export type EnrollConflict = { personId: string; name: string; reason: EnrollConflictReason; detail?: string; enrollmentId?: string };

export type EnrollCandidate = {
  personId: string;
  name: string;
  companyName: string | null;
  foUserId: string;
  foName: string;
  assignedBy: 'owner' | 'round_robin' | 'fixed';
  startDate: LocalDate;
  /** The person's Twenty podOwner differs from the campaign pod (warning, not a block). */
  podMismatch: boolean;
};

export type EnrollPreview = { candidates: EnrollCandidate[]; conflicts: EnrollConflict[]; warnings: string[] };

/**
 * Rule 4 preview: who can be enrolled, who cannot and why. Never writes.
 */
export async function previewEnrollment(req: EnrollRequest, client?: TwentyClient): Promise<EnrollPreview> {
  const settings = await getSettings();
  const conflicts: EnrollConflict[] = [];
  const warnings: string[] = [];

  if (!isLocalDate(req.startDate)) {
    return { candidates: [], conflicts: req.personIds.map((id) => ({ personId: id, name: id, reason: 'invalid_start' as const })), warnings };
  }
  const startDate = nextWorkingDay(req.startDate, settings.rules.workingDays);
  if (startDate !== req.startDate) warnings.push(`Start moved from ${req.startDate} to ${startDate} (next working day).`);

  // Dedupe ids
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of req.personIds) {
    const id = raw.trim();
    if (!id) continue;
    if (seen.has(id)) {
      conflicts.push({ personId: id, name: id, reason: 'duplicate' });
      continue;
    }
    seen.add(id);
    ids.push(id);
  }

  // Make sure we know these people
  try {
    const c = client ?? (await getTwentyClient());
    await ensurePeopleCached(c, ids);
  } catch (err) {
    warnings.push(`Could not fetch people from Twenty (${err instanceof Error ? err.message : String(err)}); using the local cache.`);
  }
  const people = await prisma.personCache.findMany({ where: { id: { in: ids } } });
  const byId = new Map(people.map((p) => [p.id, p]));

  const pod = await prisma.pod.findUnique({ where: { id: req.podId }, include: { users: { include: { user: true } } } });
  if (!pod || pod.archived) throw new Error('Pod not found or removed');
  const podFos = pod.users.map((u) => u.user).filter((u) => u.active);
  const assignment = req.assignment;
  const fixedFoId = assignment.mode === 'FIXED' ? assignment.foUserId : null;
  const restrictIds = assignment.mode !== 'FIXED' && assignment.foUserIds?.length ? new Set(assignment.foUserIds) : null;
  const allowed = restrictIds ? podFos.filter((u) => restrictIds.has(u.id)) : podFos;
  const fixedFo = fixedFoId ? podFos.find((u) => u.id === fixedFoId) : null;
  if (assignment.mode === 'FIXED' && !fixedFo) throw new Error('Assigned FO must be an active member of this pod');

  const active = await prisma.enrollment.findMany({ where: { personId: { in: ids }, status: { in: OCCUPYING_STATUSES } }, include: { campaign: true } });
  const activeByPerson = new Map(active.map((e) => [e.personId, e]));

  // Load for round robin balance and ramp
  const loadRows = await prisma.enrollment.groupBy({
    by: ['foUserId', 'startDate'],
    where: { ...(req.campaignId ? { campaignId: req.campaignId } : { status: { in: OCCUPYING_STATUSES } }), foUserId: { in: [...allowed.map((u) => u.id), ...(fixedFo ? [fixedFo.id] : [])] } },
    _count: { _all: true },
  });
  const perFoTotal = new Map<string, number>();
  const perFoDay = new Map<string, DayLoad>();
  for (const row of loadRows) {
    perFoTotal.set(row.foUserId, (perFoTotal.get(row.foUserId) ?? 0) + row._count._all);
    const m = perFoDay.get(row.foUserId) ?? new Map<string, number>();
    m.set(row.startDate, (m.get(row.startDate) ?? 0) + row._count._all);
    perFoDay.set(row.foUserId, m);
  }
  const pickLeastLoaded = () => {
    if (!allowed.length) return null;
    return [...allowed].sort((a, b) => (perFoTotal.get(a.id) ?? 0) - (perFoTotal.get(b.id) ?? 0) || a.name.localeCompare(b.name))[0];
  };

  const candidates: EnrollCandidate[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) {
      conflicts.push({ personId: id, name: id, reason: 'not_found' });
      continue;
    }
    const name = cachedPersonName(p);
    if (p.deletedAt) {
      conflicts.push({ personId: id, name, reason: 'deleted' });
      continue;
    }
    if (p.dnd) {
      conflicts.push({ personId: id, name, reason: 'dnd', detail: 'Do not contact is set in Twenty' });
      continue;
    }
    if (p.optedOut) {
      conflicts.push({ personId: id, name, reason: 'opted_out', detail: 'Asked not to be contacted (recorded in Cadence)' });
      continue;
    }
    if (p.badEmail && p.badPhone) warnings.push(`${name}: email and phone are flagged as bad data.`);
    const existing = activeByPerson.get(id);
    if (existing) {
      conflicts.push({
        personId: id,
        name,
        reason: 'already_active',
        enrollmentId: existing.id,
        detail: `${existing.status.toLowerCase()} in ${existing.campaign?.name ?? 'a sequence'} since ${existing.startDate}`,
      });
      continue;
    }

    let fo = fixedFo ?? null;
    let assignedBy: EnrollCandidate['assignedBy'] = 'fixed';
    if (!fo && req.assignment.mode === 'OWNER' && p.ownerMemberId) {
      fo = allowed.find((u) => u.twentyMemberId === p.ownerMemberId) ?? null;
      if (fo) assignedBy = 'owner';
    }
    if (!fo) {
      fo = pickLeastLoaded();
      assignedBy = 'round_robin';
    }
    if (!fo) {
      conflicts.push({ personId: id, name, reason: 'no_fo', detail: 'No active FO in this pod' });
      continue;
    }
    perFoTotal.set(fo.id, (perFoTotal.get(fo.id) ?? 0) + 1);

    let personStart = startDate;
    if (req.dailyRampPerFo && req.dailyRampPerFo > 0) {
      const load = perFoDay.get(fo.id) ?? new Map<string, number>();
      personStart = findDateWithCapacity(startDate, 1, req.dailyRampPerFo, load, settings.rules.workingDays);
      reserve(load, personStart, 1);
      perFoDay.set(fo.id, load);
    }

    candidates.push({
      personId: id,
      name,
      companyName: p.companyName,
      foUserId: fo.id,
      foName: fo.name,
      assignedBy,
      startDate: personStart,
      podMismatch: Boolean(p.podOwner && p.podOwner !== pod.podOwnerValue),
    });
  }
  if (candidates.some((c) => c.podMismatch)) warnings.push('Some people belong to a different Twenty podOwner than this pod.');
  return { candidates, conflicts, warnings };
}

export type EnrollOutcome = {
  enrolled: Array<{ enrollmentId: string; personId: string; foUserId: string; startDate: LocalDate }>;
  conflicts: EnrollConflict[];
  warnings: string[];
};

/** Enrol everyone the preview allows. Each enrollment gets its first step immediately. */
export async function enrollPeople(req: EnrollRequest, ctx: Omit<EngineContext, 'actor'> = {}, client?: TwentyClient): Promise<EnrollOutcome> {
  const preview = await previewEnrollment(req, client);
  const sequence = await prisma.sequence.findUnique({ where: { id: req.sequenceId } });
  if (!sequence) throw new Error('Sequence not found');
  const engineCtx: EngineContext = { actor: req.actor, now: ctx.now, skipSync: ctx.skipSync };
  const enrolled: EnrollOutcome['enrolled'] = [];
  const conflicts = [...preview.conflicts];

  for (const c of preview.candidates) {
    try {
      const person = await prisma.personCache.findUnique({ where: { id: c.personId }, select: { companyId: true } });
      const e = await prisma.$transaction(async (tx) => {
        const created = await tx.enrollment.create({
          data: {
            personId: c.personId,
            companyId: person?.companyId ?? null,
            foUserId: c.foUserId,
            podId: req.podId,
            campaignId: req.campaignId ?? null,
            sequenceId: sequence.id,
            startDate: c.startDate,
            status: 'ACTIVE',
            createdById: req.actor.type === 'USER' ? req.actor.id ?? null : null,
            // The engine's clock, not the database's. In production they are the same instant;
            // in a replay or a test they must agree, because the evidence window is measured
            // from this timestamp and a mismatch silently turns completions into plain touches.
            ...(ctx.now ? { createdAt: ctx.now } : {}),
          },
        });
        await logAudit(
          {
            entityType: 'enrollment',
            entityId: created.id,
            action: 'enrolled',
            actor: req.actor,
            details: { personId: c.personId, foUserId: c.foUserId, assignedBy: c.assignedBy, startDate: c.startDate, campaignId: req.campaignId ?? null },
          },
          tx,
        );
        return created;
      });
      await advanceEnrollment(e.id, engineCtx);
      enrolled.push({ enrollmentId: e.id, personId: c.personId, foUserId: c.foUserId, startDate: c.startDate });
    } catch (err) {
      if (isUniqueViolation(err)) {
        conflicts.push({ personId: c.personId, name: c.name, reason: 'already_active', detail: 'Enrolled concurrently' });
      } else {
        throw err;
      }
    }
  }
  return { enrolled, conflicts, warnings: preview.warnings };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function loadEnrollment(id: string) {
  const e = await prisma.enrollment.findUnique({ where: { id } });
  if (!e) throw new Error('Enrollment not found');
  return e;
}

export async function exitEnrollment(enrollmentId: string, opts: { reason: string; actor: AuditActor } & Omit<EngineContext, 'actor'>): Promise<Enrollment> {
  const now = opts.now ?? new Date();
  const { updated, cancelled } = await prisma.$transaction(async (tx) => {
    const e = await tx.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!e) throw new Error('Enrollment not found');
    if (!OCCUPYING_STATUSES.includes(e.status)) return { updated: e, cancelled: [] as { id: string }[] };
    const cancelled = await cancelOpenTasks(tx, enrollmentId, `exited:${opts.reason}`, opts.actor);
    const updated = await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: 'EXITED', exitReason: opts.reason, exitedAt: now } });
    await logAudit({ entityType: 'enrollment', entityId: enrollmentId, action: 'exited', actor: opts.actor, details: { reason: opts.reason, cancelledTasks: cancelled.length } }, tx);
    return { updated, cancelled };
  });
  await syncCancelled(cancelled.map((t) => t.id), { actor: opts.actor, skipSync: opts.skipSync });
  return updated;
}

export async function pauseEnrollment(enrollmentId: string, opts: { reason: string; actor: AuditActor; now?: Date }): Promise<Enrollment> {
  const now = opts.now ?? new Date();
  const e = await loadEnrollment(enrollmentId);
  if (e.status !== 'ACTIVE') return e;
  const updated = await prisma.enrollment.update({ where: { id: enrollmentId }, data: { status: 'PAUSED', pausedAt: now, pauseReason: opts.reason } });
  await logAudit({ entityType: 'enrollment', entityId: enrollmentId, action: 'paused', actor: opts.actor, details: { reason: opts.reason } });
  return updated;
}

/**
 * Resume a paused enrollment. In shift mode the pause length is added to the clock and
 * pending tasks move to today or later, so the cadence resumes with its spacing intact.
 */
export async function resumeEnrollment(enrollmentId: string, opts: { actor: AuditActor } & Omit<EngineContext, 'actor'>): Promise<{ enrollment: Enrollment; resumed: boolean; refused: string | null }> {
  const settings = await getSettings();
  const now = opts.now ?? new Date();
  const { updated, movedIds, refused } = await prisma.$transaction(async (tx) => {
    const identity = await tx.enrollment.findUnique({ where: { id: enrollmentId }, select: { campaignId: true } });
    if (identity?.campaignId) await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${identity.campaignId}`}))`;
    const e = await tx.enrollment.findUnique({ where: { id: enrollmentId }, include: { fo: true } });
    if (!e) throw new Error('Enrollment not found');
    if (e.status !== 'PAUSED') return { updated: e, movedIds: [] as string[], refused: 'This enrollment is not paused.' as string | null };
    if (e.campaignId) { const campaign = await tx.campaign.findUnique({ where: { id: e.campaignId } }); if (campaign?.status !== 'ACTIVE') return { updated: e, movedIds: [] as string[], refused: 'The campaign itself is paused. Resume the campaign to release its people.' as string | null }; }
    const today = todayIn(WORKSPACE_TIMEZONE, now);
    const pausedOn = e.pausedAt ? todayIn(WORKSPACE_TIMEZONE, e.pausedAt) : today;
    const pausedDays = Math.max(0, diffDays(pausedOn, today));
    const shiftDays = settings.rules.clockMode === 'shift' ? e.shiftDays + pausedDays : e.shiftDays;
    const movedIds: string[] = [];
    if (settings.rules.clockMode === 'shift') {
      const pending = await tx.task.findMany({ where: { enrollmentId, state: 'PENDING' } });
      for (const t of pending) {
        const target = nextWorkingDay(t.dueDate < today ? today : t.dueDate, settings.rules.workingDays);
        if (target !== t.dueDate || t.snoozedTo) {
          await tx.task.update({ where: { id: t.id }, data: { dueDate: target, dueAt: localDateToInstant(target, e.fo.timezone, 9), snoozedTo: null } });
          movedIds.push(t.id);
        }
      }
    }
    const updated = await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: 'ACTIVE', pausedAt: null, pauseReason: null, shiftDays } });
    await logAudit({ entityType: 'enrollment', entityId: enrollmentId, action: 'resumed', actor: opts.actor, details: { pausedDays, shiftDays, movedTasks: movedIds.length } }, tx);
    return { updated, movedIds, refused: null as string | null };
  });
  if (refused) return { enrollment: updated, resumed: false as const, refused };
  if (!opts.skipSync) for (const t of await loadSyncTasks(movedIds)) await syncTaskRescheduled(t);
  await advanceEnrollment(enrollmentId, { actor: opts.actor, now, skipSync: opts.skipSync });
  return { enrollment: updated, resumed: true as const, refused: null };
}

/** Hand an enrollment (and its pending tasks) to another FO in the same pod. */
export async function reassignEnrollment(enrollmentId: string, newFoUserId: string, opts: { actor: AuditActor } & Omit<EngineContext, 'actor'>): Promise<Enrollment> {
  const e = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, include: { pod: { include: { users: true } } } });
  if (!e) throw new Error('Enrollment not found');
  if (e.foUserId === newFoUserId) return e;
  const fo = await prisma.user.findUnique({ where: { id: newFoUserId } });
  if (!fo || !fo.active) throw new Error('Target FO not found or inactive');
  if (e.pod && !e.pod.users.some((u) => u.userId === newFoUserId)) throw new Error(`${fo.name} is not a member of ${e.pod.name}`);

  const pendingBefore = await prisma.task.findMany({ where: { enrollmentId, state: 'PENDING' }, include: { enrollment: { include: { person: true, sequence: true } }, fo: true } });
  const updated = await prisma.$transaction(async (tx) => {
    const pending = await tx.task.findMany({ where: { enrollmentId, state: 'PENDING' } });
    for (const t of pending) {
      await tx.task.update({ where: { id: t.id }, data: { foUserId: newFoUserId, dueAt: localDateToInstant(t.snoozedTo ?? t.dueDate, fo.timezone, 9), twentyTaskId: null } });
    }
    const u = await tx.enrollment.update({ where: { id: enrollmentId }, data: { foUserId: newFoUserId } });
    await logAudit({ entityType: 'enrollment', entityId: enrollmentId, action: 'reassigned', actor: opts.actor, details: { from: e.foUserId, to: newFoUserId, tasks: pending.length } }, tx);
    return u;
  });
  if (!opts.skipSync) {
    // Mirrored Twenty tasks carry the assignee: replace them.
    for (const t of pendingBefore) if (t.twentyTaskId) await syncTaskResolved(t);
    await syncTasksCreated(await loadSyncTasks(pendingBefore.map((t) => t.id)));
  }
  return updated;
}

/** Rule 3: inbound reply from the person. Closes open tasks; optionally pauses colleagues. */
export async function markReplied(
  enrollmentId: string,
  opts: { at: Date; evidenceId?: string | null; actor: AuditActor; skipSync?: boolean },
): Promise<{ enrollment: Enrollment; pausedColleagues: number; changed: boolean }> {
  const settings = await getSettings();
  const result = await prisma.$transaction(async (tx) => {
    const e = await tx.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!e) throw new Error('Enrollment not found');
    if (!OCCUPYING_STATUSES.includes(e.status)) return { enrollment: e, cancelled: [] as { id: string }[], pausedColleagues: 0, changed: false };
    const cancelled = await cancelOpenTasks(tx, enrollmentId, 'replied', opts.actor);
    const updated = await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: 'REPLIED', repliedAt: opts.at } });
    await logAudit({ entityType: 'enrollment', entityId: enrollmentId, action: 'replied', actor: opts.actor, details: { evidenceId: opts.evidenceId ?? null, cancelledTasks: cancelled.length } }, tx);

    let pausedColleagues = 0;
    if (settings.rules.companyReplyPausesColleagues && e.companyId) {
      const colleagues = await tx.enrollment.findMany({ where: { companyId: e.companyId, status: 'ACTIVE', id: { not: enrollmentId } } });
      for (const c of colleagues) {
        await tx.enrollment.update({ where: { id: c.id }, data: { status: 'PAUSED', pausedAt: opts.at, pauseReason: `colleague_replied:${e.personId}` } });
        await logAudit({ entityType: 'enrollment', entityId: c.id, action: 'paused', actor: opts.actor, details: { reason: 'colleague_replied', colleagueEnrollmentId: enrollmentId } }, tx);
        pausedColleagues += 1;
      }
    }
    return { enrollment: updated, cancelled, pausedColleagues, changed: true };
  });
  await syncCancelled(result.cancelled.map((t) => t.id), { actor: opts.actor, skipSync: opts.skipSync });
  return { enrollment: result.enrollment, pausedColleagues: result.pausedColleagues, changed: result.changed };
}

/** Rule 3: meeting booked (an opportunity was created for the person in Twenty). */
export async function markMeeting(
  enrollmentId: string,
  opts: { at: Date; evidenceId?: string | null; actor: AuditActor; skipSync?: boolean },
): Promise<{ enrollment: Enrollment; changed: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    const e = await tx.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!e) throw new Error('Enrollment not found');
    if (!OCCUPYING_STATUSES.includes(e.status) && e.status !== 'REPLIED') return { enrollment: e, cancelled: [] as { id: string }[], changed: false };
    const cancelled = await cancelOpenTasks(tx, enrollmentId, 'meeting', opts.actor);
    const updated = await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: 'MEETING', meetingAt: opts.at } });
    await logAudit({ entityType: 'enrollment', entityId: enrollmentId, action: 'meeting', actor: opts.actor, details: { evidenceId: opts.evidenceId ?? null, cancelledTasks: cancelled.length } }, tx);
    return { enrollment: updated, cancelled, changed: true };
  });
  await syncCancelled(result.cancelled.map((t) => t.id), { actor: opts.actor, skipSync: opts.skipSync });
  return { enrollment: result.enrollment, changed: result.changed };
}

/** Rule 4: dnd flipping to true (or the person being deleted) exits the active enrollment. */
export async function applyPersonFlags(
  person: Pick<TwentyPerson, 'id' | 'dnd' | 'deletedAt'>,
  opts: { actor: AuditActor; now?: Date; skipSync?: boolean },
): Promise<{ exited: string[] }> {
  const exited: string[] = [];
  if (!person.dnd && !person.deletedAt) return { exited };
  const reason = person.deletedAt ? 'person_deleted' : 'dnd';
  const active = await prisma.enrollment.findMany({ where: { personId: person.id, status: { in: OCCUPYING_STATUSES } } });
  for (const e of active) {
    await exitEnrollment(e.id, { reason, actor: opts.actor, now: opts.now, skipSync: opts.skipSync });
    exited.push(e.id);
  }
  return { exited };
}

/**
 * Outreach "Mark Finished" / "Mark Replied": end the enrollment by hand.
 * replied -> REPLIED (counts in reply rates); no_reply -> COMPLETED (Finished, no reply).
 */
export async function finishEnrollment(enrollmentId: string, kind: 'replied' | 'no_reply', opts: { actor: AuditActor } & Omit<EngineContext, 'actor'>): Promise<Enrollment> {
  const now = opts.now ?? new Date();
  if (kind === 'replied') {
    const r = await markReplied(enrollmentId, { at: now, evidenceId: null, actor: opts.actor, skipSync: opts.skipSync });
    return r.enrollment;
  }
  const { updated, cancelled } = await prisma.$transaction(async (tx) => {
    const e = await tx.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!e) throw new Error('Enrollment not found');
    if (!OCCUPYING_STATUSES.includes(e.status)) return { updated: e, cancelled: [] as { id: string }[] };
    const cancelled = await cancelOpenTasks(tx, enrollmentId, 'finished_no_reply', opts.actor);
    const updated = await tx.enrollment.update({ where: { id: enrollmentId }, data: { status: 'COMPLETED', completedAt: now, exitReason: 'finished_manually' } });
    await logAudit({ entityType: 'enrollment', entityId: enrollmentId, action: 'finished', actor: opts.actor, details: { kind, cancelledTasks: cancelled.length } }, tx);
    return { updated, cancelled };
  });
  await syncCancelled(cancelled.map((t) => t.id), { actor: opts.actor, skipSync: opts.skipSync });
  return updated;
}

/** Cadence-local person flags (Twenty is never written): opted out, bad email, bad phone. */
export async function setPersonFlags(personId: string, flags: { optedOut?: boolean; badEmail?: boolean; badPhone?: boolean }, actor: AuditActor) {
  const data: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(flags)) if (typeof v === 'boolean') data[k] = v;
  if (!Object.keys(data).length) return;
  await prisma.personCache.update({ where: { id: personId }, data });
  await logAudit({ entityType: 'person', entityId: personId, action: 'flags_updated', actor, details: data });
}

export async function colleagueEnrollments(companyId: string | null, excludePersonId: string) {
  if (!companyId) return [];
  return prisma.enrollment.findMany({
    where: { companyId, personId: { not: excludePersonId }, status: { in: [...OCCUPYING_STATUSES, 'REPLIED', 'MEETING'] } },
    include: { person: true, fo: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}
