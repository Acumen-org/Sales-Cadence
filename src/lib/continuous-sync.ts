import { randomBytes } from 'node:crypto';
import { prisma } from './db';
import { hashPassword } from './auth/password';
import { WORKSPACE_TIMEZONE } from './workspace';
import { getTwentyClient } from './twenty';
import { refreshPersonCache } from './person-cache';
import { reconcile } from './engine/reconcile';
import { SYSTEM_ACTOR } from './audit';
import type { TwentyClient } from './twenty/client';

/** Discover CRM members without granting login access or restoring removed users. */
export async function syncWorkspaceMembers(client: TwentyClient) {
  const members = await client.listWorkspaceMembers();
  for (const member of members) {
    const email = member.email?.trim().toLowerCase(); if (!email) continue;
    const existing = await prisma.user.findFirst({ where: { OR: [{ twentyMemberId: member.id }, { email }] } });
    if (existing) {
      if (!existing.twentyMemberId) await prisma.user.updateMany({ where: { id: existing.id, twentyMemberId: null }, data: { twentyMemberId: member.id, timezone: WORKSPACE_TIMEZONE } });
    } else {
      await prisma.user.upsert({ where: { email }, create: { email, name: [member.firstName,member.lastName].filter(Boolean).join(' ') || email, twentyMemberId: member.id, timezone: WORKSPACE_TIMEZONE, role: 'JUNIOR_FO', active: false, passwordHash: await hashPassword(randomBytes(32).toString('hex')) }, update: {} });
    }
  }
}

/** What Settings > Twenty reads: when the sync last worked, what failed, and what the last pass saw. */
export type ContinuousSyncState = {
  watermark: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  attemptedAt?: string;
  /** When the cache was last rebuilt from a complete listing of Twenty. */
  lastFullRefresh?: string | null;
  /** Stages of the last pass that stopped part-way. The pass still counts as run. */
  stageErrors?: Record<string, string>;
  /** CRM events the last pass could not apply, waiting in Settings > Activity log. */
  needsReview?: number;
  lastRun?: { people: number; companies: number; notes: number; messages: number; opportunities: number; tasks: number; removed: number };
};

/** A full listing of Twenty once a day, on top of the change scans, so the cache cannot drift. */
const FULL_REFRESH_EVERY_MS = 24 * 3600_000;

/**
 * The pass the worker runs every CRM_SYNC_SECONDS. People and companies changed since the
 * watermark are cached, deletions are fetched on purpose, and notes, messages, tasks and
 * opportunities in the window go through the same ingestion as webhooks.
 *
 * The watermark moves when the people stage completed. Anything else that failed - messages the
 * API key cannot read, an object the workspace renamed - is recorded against its stage and shown
 * in Settings, and the next pass tries it again from the new watermark. The earlier rule, where
 * any failure anywhere threw and kept the watermark, meant one permanent failure froze the whole
 * sync: the full refresh reran and failed at the same spot every minute, and the workspace showed
 * a handful of contacts with nothing to say why.
 */
export async function syncContinuously(now = new Date(), injected?: TwentyClient) {
  const previous = await prisma.setting.findUnique({ where: { key: 'continuousSync' } });
  const state = (previous?.value ?? null) as ContinuousSyncState | null;
  const save = async (value: ContinuousSyncState) => {
    await prisma.setting.upsert({ where: { key: 'continuousSync' }, create: { key: 'continuousSync', value }, update: { value } });
  };
  try {
    const client = injected ?? (await getTwentyClient());
    const lastFull = state?.lastFullRefresh ? new Date(state.lastFullRefresh).getTime() : 0;
    const fullDue = !state?.watermark || now.getTime() - lastFull >= FULL_REFRESH_EVERY_MS;
    let removed = 0;
    let companies = 0;
    let lastFullRefresh = state?.lastFullRefresh ?? null;
    const stageErrors: Record<string, string> = {};
    if (fullDue) {
      const full = await refreshPersonCache(client);
      removed = full.removed;
      companies = full.companies;
      for (const [name, message] of Object.entries(full.stageErrors)) if (message) stageErrors[`full.${name}`] = message;
      if (!full.stageErrors.people) lastFullRefresh = now.toISOString();
      else if (!state?.watermark) throw new Error(`People could not be listed from Twenty: ${full.stageErrors.people}`);
    }
    try {
      await syncWorkspaceMembers(client);
    } catch (error) {
      stageErrors.members = error instanceof Error ? error.message : String(error);
    }
    const watermark = state?.watermark ? new Date(state.watermark).getTime() : now.getTime() - 14 * 86400000;
    const since = new Date(watermark - 10 * 60000).toISOString();
    const result = await reconcile({ since, now, actor: SYSTEM_ACTOR }, client);
    Object.assign(stageErrors, result.stageErrors);
    const peopleFailed = stageErrors['cache.people'] ?? stageErrors.people;
    if (peopleFailed) throw new Error(`People could not be listed from Twenty: ${peopleFailed}`);
    const failing = Object.keys(stageErrors);
    await save({
      watermark: now.toISOString(),
      lastSuccess: now.toISOString(),
      lastError: failing.length ? `${failing.join(', ')} did not finish` : null,
      lastFullRefresh,
      stageErrors,
      needsReview: result.needsReview,
      lastRun: { people: result.people, companies, notes: result.notes, messages: result.messages, opportunities: result.opportunities, tasks: result.tasks, removed },
    });
    return result;
  } catch (error) {
    await save({
      watermark: state?.watermark ?? null,
      lastSuccess: state?.lastSuccess ?? null,
      lastFullRefresh: state?.lastFullRefresh ?? null,
      lastError: error instanceof Error ? error.message : 'CRM sync failed',
      attemptedAt: now.toISOString(),
    });
    throw error;
  }
}
