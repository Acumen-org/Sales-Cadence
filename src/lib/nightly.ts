import { prisma } from './db';
import { diffDays, todayIn } from './dates';
import { workspaceTimezone } from './workspace';

/*
 * The nightly jobs (N087): the CRM reconcile and cache refresh, the cold outreach CRM check and
 * retention, and the push keys forgotten. They run in a loop of their own beside the worker's tick,
 * so imports, forms, moves and launches keep their two-minute pace while a long CRM check runs. Each
 * run records when it started, when it ended and how long each job took, under its own marker
 * (B214), for Settings > Cold outreach and the health card.
 */

export const NIGHTLY_MARKER = 'nightlyRanOn';
/** A run still going after this long turns the health card amber (PLAN 4.7). */
export const NIGHTLY_SLOW_MS = 30 * 60_000;

export type NightlyJob = { name: string; /** It talks to the CRM: the tick's own CRM sync waits for it rather than racing it. */ crm?: boolean; run: () => Promise<unknown> };
export type NightlyJobRun = { name: string; ms: number; ok: boolean; error?: string };
/**
 * The marker. `day` and `at` are the last finished run (a restart never repeats a finished day);
 * `running` is a run in progress, `startedAt`, `finishedAt`, `durationMs` and `jobs` the last one.
 */
export type NightlyMarker = { day?: string; at?: string; startedAt?: string; finishedAt?: string; durationMs?: number; jobs?: NightlyJobRun[]; running?: { startedAt: string } | null };

export async function readNightly(): Promise<NightlyMarker | null> {
  const row = await prisma.setting.findUnique({ where: { key: NIGHTLY_MARKER } });
  return (row?.value ?? null) as NightlyMarker | null;
}

async function writeNightly(value: NightlyMarker) {
  const json = JSON.parse(JSON.stringify(value));
  await prisma.setting.upsert({ where: { key: NIGHTLY_MARKER }, create: { key: NIGHTLY_MARKER, value: json }, update: { value: json } });
}

/** Whether tonight's run is due: the workspace's hour has come, and no run has finished today. */
export async function nightlyDue(now: Date, hour: number): Promise<boolean> {
  const local = Number(new Intl.DateTimeFormat('en-GB', { timeZone: workspaceTimezone(), hour: '2-digit', hour12: false }).format(now));
  if (local < hour) return false;
  return (await readNightly())?.day !== todayIn(workspaceTimezone(), now);
}

/** P13: a run marked as started this long ago with no end died with its worker, and may be claimed again. */
export const NIGHTLY_STALE_MS = 3 * 60 * 60_000;

/**
 * P13: tonight's run, claimed under a lock, so two workers alive at once (a deploy overlap) never both
 * run it: the second finds it finished today or running elsewhere. Null when it is not this worker's.
 */
export async function claimNightly(now: Date): Promise<Date | null> {
  const today = todayIn(workspaceTimezone(), now);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('nightly-claim'))`;
    const marker = ((await tx.setting.findUnique({ where: { key: NIGHTLY_MARKER } }))?.value ?? {}) as NightlyMarker;
    if (marker.day === today) return null;
    const since = marker.running?.startedAt ? Date.parse(marker.running.startedAt) : NaN;
    if (Number.isFinite(since) && Date.now() - since < NIGHTLY_STALE_MS) return null;
    const started = new Date();
    const json = JSON.parse(JSON.stringify({ ...marker, running: { startedAt: started.toISOString() } }));
    await tx.setting.upsert({ where: { key: NIGHTLY_MARKER }, create: { key: NIGHTLY_MARKER, value: json }, update: { value: json } });
    return started;
  });
}

/** P14: a worker stopping mid-run gives the run back, so the next worker runs it at once. */
async function releaseNightly(started: Date) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('nightly-claim'))`;
    const marker = ((await tx.setting.findUnique({ where: { key: NIGHTLY_MARKER } }))?.value ?? {}) as NightlyMarker;
    if (marker.running?.startedAt !== started.toISOString()) return;
    await tx.setting.update({ where: { key: NIGHTLY_MARKER }, data: { value: JSON.parse(JSON.stringify({ ...marker, running: null })) } });
  });
}

/** The day of the last finished run, so tonight's reconcile reaches back over any days it missed (P31). */
export async function nightlyLookbackDays(now: Date, minimum: number): Promise<number> {
  const last = (await readNightly())?.day;
  if (!last) return minimum;
  const missed = diffDays(last, todayIn(workspaceTimezone(), now));
  return Math.min(90, Math.max(minimum, missed + 1));
}

/** The marker says a run is in progress, since now; the last finished run stays as it was. */
async function markNightlyStarted(): Promise<Date> {
  const started = new Date();
  await writeNightly({ ...((await readNightly()) ?? {}), running: { startedAt: started.toISOString() } });
  return started;
}

/**
 * One nightly run: each job in order, timed, a failure recorded and the next job run all the same.
 * The marker says a run is in progress from the start, and records the day, the times and each job
 * when it ends.
 */
export async function runNightly(now: Date, jobs: NightlyJob[], hooks: { log?: (message: string, extra?: unknown) => void; onCrm?: (busy: boolean) => void } = {}, marked?: Date): Promise<NightlyMarker> {
  const started = marked ?? (await markNightlyStarted());
  const runs: NightlyJobRun[] = [];
  for (const job of jobs) {
    const t = Date.now();
    if (job.crm) hooks.onCrm?.(true);
    try {
      const result = await job.run();
      runs.push({ name: job.name, ms: Date.now() - t, ok: true });
      hooks.log?.(job.name, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runs.push({ name: job.name, ms: Date.now() - t, ok: false, error: message.slice(0, 300) });
      hooks.log?.(`${job.name} failed`, error);
    } finally {
      if (job.crm) hooks.onCrm?.(false);
    }
  }
  const finished = new Date();
  const marker: NightlyMarker = { day: todayIn(workspaceTimezone(), now), at: finished.toISOString(), startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(), jobs: runs, running: null };
  await writeNightly(marker);
  return marker;
}

/**
 * The nightly loop's single flight: `poke` starts tonight's run when it is due and none is running,
 * and returns at once. The worker pokes it each tick and goes on with its own work.
 */
export function nightlyLoop(opts: { hour: number; jobs: () => NightlyJob[]; log?: (message: string, extra?: unknown) => void }) {
  let running: Promise<unknown> | null = null;
  let checking = false;
  /** The day this process started a run, or found one finished: never twice a day (B214). */
  let doneDay: string | null = null;
  let crmBusy = false;
  let startedAt: Date | null = null;
  return {
    /** Starts the run when due; true when it started one. Never waits for the jobs themselves. */
    async poke(now: Date): Promise<boolean> {
      const today = todayIn(workspaceTimezone(), now);
      if (running || checking || doneDay === today) return false;
      checking = true;
      try {
        if (!(await nightlyDue(now, opts.hour))) {
          if ((await readNightly())?.day === today) doneDay = today;
          return false;
        }
      } finally {
        checking = false;
      }
      // Marked as running before the tick goes on, so the health card never reads it as not run.
      // P13: claimed, not just written: another worker running it, or done with it, keeps it.
      const started = await claimNightly(now);
      if (!started) return false;
      doneDay = today;
      startedAt = started;
      running = runNightly(now, opts.jobs(), { log: opts.log, onCrm: (busy) => { crmBusy = busy; } }, started)
        .catch((error) => opts.log?.('nightly failed', error))
        .finally(() => { running = null; startedAt = null; });
      return true;
    },
    /** P14: stopping while a run is in progress: give the run back for the next worker, rather than hold the stop for it. */
    async release(): Promise<void> {
      if (running && startedAt) await releaseNightly(startedAt);
    },
    /** A nightly CRM job is running: the tick's continuous CRM sync skips its turn. */
    get crmBusy() { return crmBusy; },
    get running() { return running !== null; },
    /** For a clean stop: the run in progress, if any. */
    settled(): Promise<unknown> { return running ?? Promise.resolve(); },
  };
}
