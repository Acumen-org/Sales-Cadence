'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { retryFailedWrites } from '@/lib/engine/sync-retry';
import { requireAdmin } from '../auth/current-user';
import { userActor } from '../audit';
import { refreshPersonCache, syncPodsFromTwenty } from '../person-cache';
import { runSchedulerTick } from '../engine/tasks';
import { reconcile } from '../engine/reconcile';
import { syncContinuously } from '../continuous-sync';
import { resolveReview } from '../engine/ingest';
import { getTwentyClient } from '../twenty';
import type { ActionResult } from './users';

/** The same pass the worker runs every minute, now. */
export async function syncNowAction(): Promise<ActionResult> {
  await requireAdmin();
  try {
    const stats = await syncContinuously();
    for (const path of ['/settings', '/people', '/accounts', '/tasks', '/home']) revalidatePath(path);
    // One word is the answer wanted here: did it update. Detail lives in Settings > Twenty.
    const stages = Object.keys(stats.stageErrors);
    if (stages.length) return { ok: false, error: `Synced, except ${stages.join(', ')}.` };
    return { ok: true, message: 'Synced.' };
  } catch (err) {
    return { ok: false, error: `Sync failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runReconcileAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const raw = String(formData.get('days') ?? '').trim();
  const days = raw ? Number.parseInt(raw, 10) : undefined;
  if (raw && (!days || days < 1 || days > 90)) return { ok: false, error: 'Days must be between 1 and 90.' };
  try {
    const stats = await reconcile({ days, actor: userActor(admin) });
    revalidatePath('/settings');
    revalidatePath('/tasks');
    return {
      ok: true,
      message: `Reconciled since ${stats.since.slice(0, 10)}: ${stats.notes} notes, ${stats.messages} messages, ${stats.opportunities} opportunities, ${stats.people} people. ${stats.completions} completions, ${stats.replies} replies, ${stats.meetings} meetings, ${stats.duplicates} already seen, ${stats.errors} errors, ${stats.needsReview} to review.`,
    };
  } catch (err) {
    return { ok: false, error: `Reconcile failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function refreshCacheAction(formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const full = formData.get('full') === 'true';
  try {
    const client = await getTwentyClient();
    const since = full ? undefined : new Date(Date.now() - 36 * 3_600_000).toISOString();
    const stats = await refreshPersonCache(client, { since });
    revalidatePath('/people');
    revalidatePath('/settings');
    return { ok: true, message: `Cache refreshed: ${stats.people} people, ${stats.companies} companies${full ? ' (full)' : ' (changed in the last 36h)'}.` };
  } catch (err) {
    return { ok: false, error: `Refresh failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Create or rename pods from the podOwner options in Twenty. */
export async function syncPodsAction(): Promise<ActionResult> {
  await requireAdmin();
  try {
    const client = await getTwentyClient();
    const r = await syncPodsFromTwenty(client);
    revalidatePath('/settings');
    revalidatePath('/people');
    if (!r.options) return { ok: false, error: 'Twenty did not report any podOwner options (check the field name in Settings > Twenty).' };
    return { ok: true, message: `${r.options} pod options in Twenty. ${r.created.length ? `Created: ${r.created.join(', ')}. ` : ''}${r.renamed.length ? `Renamed: ${r.renamed.join(', ')}. ` : ''}${!r.created.length && !r.renamed.length ? 'Pods already match.' : ''}` };
  } catch (err) {
    return { ok: false, error: `Pod sync failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runSchedulerAction(): Promise<ActionResult> {
  const admin = await requireAdmin();
  const stats = await runSchedulerTick({ actor: userActor(admin) });
  revalidatePath('/tasks');
  return { ok: true, message: `Scheduler: ${stats.scanned} active enrollments scanned, ${stats.generated} steps generated (${stats.tasks} tasks), ${stats.completed} enrollments completed.` };
}

export async function retryTwentyWriteAction(formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const writeId = String(formData.get('writeId') ?? '');
  const result = await retryFailedWrites(writeId ? { ids: [writeId] } : { limit: 100, ignoreBackoff: true });
  revalidatePath('/settings');
  if (!result.retried) return { ok: false, error: 'Nothing is waiting to be retried, or a retry is already in progress.' };
  if (result.succeeded === result.retried) return { ok: true, message: result.retried === 1 ? 'Written to Twenty.' : `${result.succeeded} writes reached Twenty.` };
  return { ok: false, error: `${result.retried - result.succeeded} of ${result.retried} still failing: ${result.errors[0] ?? 'unknown error'}` };
}

/** A write that can never succeed (the Twenty record is gone, the payload is refused) is closed by hand. */
export async function discardTwentyWriteAction(formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const writeId = String(formData.get('writeId') ?? '');
  const changed = await prisma.twentyWrite.updateMany({ where: { id: writeId, status: { in: ['FAILED', 'RETRYING'] } }, data: { status: 'DISCARDED', nextAttemptAt: null } });
  revalidatePath('/settings');
  return changed.count ? { ok: true, message: 'Discarded. Twenty will not receive this write.' } : { ok: false, error: 'That write is no longer waiting.' };
}

export async function resolveReviewAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const eventId = String(formData.get('eventId') ?? '');
  if (!eventId) return { ok: false, error: 'Missing event.' };
  await resolveReview(eventId, userActor(admin), String(formData.get('note') ?? '') || undefined);
  revalidatePath('/settings');
  return { ok: true, message: 'Marked as reviewed.' };
}

export async function testTwentyConnectionAction(): Promise<ActionResult> {
  await requireAdmin();
  try {
    const client = await getTwentyClient();
    const r = await client.ping();
    return { ok: true, message: r.detail };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
