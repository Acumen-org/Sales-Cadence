import { randomBytes } from 'node:crypto';
import { prisma } from './db';
import { applyNeverProspectRule } from './non-prospects';
import { hashPassword } from './auth/password';
import { workspaceTimezone } from './workspace';
import { getSettings } from './settings';
import { getTwentyClient } from './twenty';
import { refreshPersonCache, type FullRefreshProgress } from './person-cache';
import { reconcile } from './engine/reconcile';
import { SYSTEM_ACTOR } from './audit';
import type { TwentyClient } from './twenty/client';

/** Discover CRM members without granting login access or restoring removed users. */
export async function syncWorkspaceMembers(client: TwentyClient) {
  const members = await client.listWorkspaceMembers();
  const current = new Set(members.map((m) => m.id));
  for (const member of members) {
    const email = member.email?.trim().toLowerCase(); if (!email) continue;
    const existing = await prisma.user.findFirst({ where: { OR: [{ twentyMemberId: member.id }, { email }] } });
    if (existing) {
      // N32: linking keeps the user's own time zone. N23: a member removed and invited again has a new
      // id; the user found by email follows it, once the old id is no longer a member at all.
      if (existing.twentyMemberId !== member.id && (!existing.twentyMemberId || !current.has(existing.twentyMemberId)) && !(await prisma.user.findFirst({ where: { twentyMemberId: member.id }, select: { id: true } }))) {
        await prisma.user.updateMany({ where: { id: existing.id, twentyMemberId: existing.twentyMemberId }, data: { twentyMemberId: member.id } });
      }
    } else {
      await prisma.user.upsert({ where: { email }, create: { email, name: [member.firstName,member.lastName].filter(Boolean).join(' ') || email, twentyMemberId: member.id, timezone: workspaceTimezone(), role: 'JUNIOR_FO', active: false, passwordHash: await hashPassword(randomBytes(32).toString('hex')) }, update: {} });
    }
  }
}

/** What Settings > Twenty reads: when the sync last worked, what failed, and what the last pass saw. */
export type ContinuousSyncState = {
  watermark: string | null;
  /** Each listing advances only after it finishes, so an outage cannot skip older events. */
  stageWatermarks?: Record<string, string>;
  lastSuccess: string | null;
  lastError: string | null;
  attemptedAt?: string;
  /** When the cache was last rebuilt from a complete listing of Twenty. */
  lastFullRefresh?: string | null;
  /** A full listing in progress: the next pass carries on from here rather than page one (N01). */
  fullRefreshProgress?: FullRefreshProgress | null;
  /** Full listings that stopped in a row, and when the next one may try again (backs off, N01). */
  fullRefreshFailures?: number;
  fullRefreshRetryAt?: string | null;
  /** Stages of the last pass that stopped part-way. The pass still counts as run. */
  stageErrors?: Record<string, string>;
  /** CRM events the last pass could not apply, waiting in Settings > Activity log. */
  needsReview?: number;
  lastRun?: { people: number; companies: number; notes: number; messages: number; opportunities: number; tasks: number; removed: number };
};

/** A full listing of Twenty once a day, on top of the change scans, so the cache cannot drift. */
const FULL_REFRESH_EVERY_MS = 24 * 3600_000;
/**
 * Pages of the full listing read per pass. Twenty allows 100 requests a minute and the pass runs
 * every minute with its own change scans, so ~8,400 people take a few passes instead of one burst.
 */
const FULL_REFRESH_PAGES_PER_PASS = 40;
/** After a failed full listing: 5 min, 10, 20 ... up to 6 h before the next try. */
export function fullRefreshBackoffMs(failures: number) {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, failures - 1), 6 * 3600_000);
}
const CURSOR_STAGES = ['cache.people', 'cache.companies', 'cache.deletedPeople', 'cache.deletedCompanies', 'people', 'deletedPeople', 'notes', 'messages', 'opportunities', 'tasks'];

/**
 * The pass the worker runs every CRM_SYNC_SECONDS. People and companies changed since the
 * watermark are cached, deletions are fetched on purpose, and notes, messages, tasks and
 * opportunities in the window go through the same ingestion as webhooks.
 *
 * Each listing retains its own watermark until it finishes. A failed messages or notes stage
 * replays its missed window after recovery while healthy stages keep advancing. Stage failures
 * remain visible in Settings; the shared watermark is retained for compatibility and status.
 */
export async function syncContinuously(now = new Date(), injected?: TwentyClient) {
  const previous = await prisma.setting.findUnique({ where: { key: 'continuousSync' } });
  const state = (previous?.value ?? null) as ContinuousSyncState | null;
  const save = async (value: ContinuousSyncState) => {
    await prisma.setting.upsert({ where: { key: 'continuousSync' }, create: { key: 'continuousSync', value }, update: { value } });
  };
  // The full listing's own state, kept on every outcome so a failed pass never loses its place.
  let lastFullRefresh = state?.lastFullRefresh ?? null;
  let fullRefreshProgress = state?.fullRefreshProgress ?? null;
  let fullRefreshFailures = state?.fullRefreshFailures ?? 0;
  let fullRefreshRetryAt = state?.fullRefreshRetryAt ?? null;
  try {
    const client = injected ?? (await getTwentyClient());
    const lastFull = state?.lastFullRefresh ? new Date(state.lastFullRefresh).getTime() : 0;
    const waiting = fullRefreshRetryAt ? now.getTime() < new Date(fullRefreshRetryAt).getTime() : false;
    const fullDue = !state?.watermark || (!waiting && (Boolean(fullRefreshProgress) || now.getTime() - lastFull >= FULL_REFRESH_EVERY_MS));
    let removed = 0;
    let companies = 0;
    const stageErrors: Record<string, string> = {};
    if (fullDue) {
      const full = await refreshPersonCache(client, { resume: fullRefreshProgress ?? undefined, pageBudget: FULL_REFRESH_PAGES_PER_PASS });
      removed = full.removed;
      companies = full.companies;
      for (const [name, message] of Object.entries(full.stageErrors)) if (message) stageErrors[`full.${name}`] = message;
      // One record that cannot be stored is reported, not a reason to read everything again.
      if (full.failed) stageErrors['full.records'] = `${full.failed} record(s) could not be stored; first: ${full.firstError}`;
      if (full.removalSkipped) stageErrors['full.removal'] = full.removalSkipped;
      const progress = full.progress ?? null;
      if (Object.keys(full.stageErrors).length) {
        fullRefreshFailures += 1;
        fullRefreshRetryAt = new Date(now.getTime() + fullRefreshBackoffMs(fullRefreshFailures)).toISOString();
        fullRefreshProgress = progress;
      } else {
        fullRefreshFailures = 0;
        fullRefreshRetryAt = null;
        const complete = Boolean(progress?.peopleDone && progress?.companiesDone);
        fullRefreshProgress = complete ? null : progress;
        if (complete) lastFullRefresh = now.toISOString();
      }
      if (full.stageErrors.people && !state?.watermark) throw new Error(`People could not be listed from the CRM: ${full.stageErrors.people}`);
    }
    try {
      await syncWorkspaceMembers(client);
    } catch (error) {
      stageErrors.members = error instanceof Error ? error.message : String(error);
    }
    const watermark = state?.watermark ? new Date(state.watermark).getTime() : now.getTime() - 14 * 86400000;
    const since = new Date(watermark - 10 * 60000).toISOString();
    const stageWatermarks = Object.fromEntries(CURSOR_STAGES.map((stage) => [stage, state?.stageWatermarks?.[stage] ?? new Date(watermark).toISOString()]));
    // N17: a listing that keeps failing re-reads at most the nightly look-back, not a window that
    // grows for as long as it fails; the nightly reconcile covers that same span.
    const floor = state?.watermark ? now.getTime() - (await getSettings()).rules.reconcileLookbackDays * 86_400_000 : 0;
    const sinceByStage = Object.fromEntries(CURSOR_STAGES.map((stage) => [stage, new Date(Math.max(new Date(stageWatermarks[stage]).getTime() - 10 * 60000, floor)).toISOString()]));
    const result = await reconcile({ since, sinceByStage, now, actor: SYSTEM_ACTOR }, client);
    Object.assign(stageErrors, result.stageErrors);
    try {
      await applyNeverProspectRule();
    } catch (error) {
      stageErrors.nonProspects = error instanceof Error ? error.message : String(error);
    }
    const peopleFailed = stageErrors['cache.people'] ?? stageErrors.people;
    if (peopleFailed) throw new Error(`People could not be listed from the CRM: ${peopleFailed}`);
    const failing = Object.keys(stageErrors);
    for (const stage of CURSOR_STAGES) if (!stageErrors[stage]) stageWatermarks[stage] = now.toISOString();
    await save({
      watermark: now.toISOString(),
      stageWatermarks,
      lastSuccess: now.toISOString(),
      lastError: failing.length ? `${failing.join(', ')} did not finish` : null,
      lastFullRefresh,
      fullRefreshProgress,
      fullRefreshFailures,
      fullRefreshRetryAt,
      stageErrors,
      needsReview: result.needsReview,
      lastRun: { people: result.people, companies, notes: result.notes, messages: result.messages, opportunities: result.opportunities, tasks: result.tasks, removed },
    });
    return result;
  } catch (error) {
    await save({
      ...(state ?? {}),
      watermark: state?.watermark ?? null,
      lastSuccess: state?.lastSuccess ?? null,
      lastFullRefresh,
      fullRefreshProgress,
      fullRefreshFailures,
      fullRefreshRetryAt,
      lastError: error instanceof Error ? error.message : 'CRM sync failed',
      attemptedAt: now.toISOString(),
    });
    throw error;
  }
}
