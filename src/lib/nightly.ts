import { prisma } from './db';
import { todayIn } from './dates';
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

/**
 * One nightly run: each job in order, timed, a failure recorded and the next job run all the same.
 * The marker says a run is in progress from the start, and records the day, the times and each job
 * when it ends.
 */
export async function runNightly(now: Date, jobs: NightlyJob[], hooks: { log?: (message: string, extra?: unknown) => void; onCrm?: (busy: boolean) => void } = {}): Promise<NightlyMarker> {
  const started = new Date();
  const previous = (await readNightly()) ?? {};
  await writeNightly({ ...previous, running: { startedAt: started.toISOString() } });
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
  return {
    /** Starts the run when due; true when it started one. Never waits for it. */
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
      doneDay = today;
      running = runNightly(now, opts.jobs(), { log: opts.log, onCrm: (busy) => { crmBusy = busy; } })
        .catch((error) => opts.log?.('nightly failed', error))
        .finally(() => { running = null; });
      return true;
    },
    /** A nightly CRM job is running: the tick's continuous CRM sync skips its turn. */
    get crmBusy() { return crmBusy; },
    get running() { return running !== null; },
    /** For a clean stop: the run in progress, if any. */
    settled(): Promise<unknown> { return running ?? Promise.resolve(); },
  };
}
