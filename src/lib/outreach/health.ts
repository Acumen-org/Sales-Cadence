import { prisma } from '../db';
import { env } from '../env';
import { todayIn } from '../dates';
import { workspaceTimezone } from '../workspace';
import { notify } from '../notifications';
import { STUCK_MS } from '../sandbox/bellwether-api';
import { STATUS_KEY as IMPORT_STATUS_KEY } from '../calls/import';
import { graphMailState } from '../mail/graph-mail';
import { NIGHTLY_SLOW_MS, readNightly } from '../nightly';
import { COLD_CONTACT_BASE, COLD_FROM_BELLWETHER_HREF, COLD_MOVES_HREF } from '../subject';
import { COLD_OUTREACH_SETTINGS_HREF } from '../settings-tabs';

/*
 * The health card (cold outreach PLAN 4.7, W13): one line for each thing that can quietly stop
 * cold outreach, each with the threshold that turns it amber. Settings > Cold outreach shows it to
 * admins; the worker checks it every few minutes and rings every admin's bell when a line turns
 * amber, once for each time it does (`ringHealth`).
 */

export type HealthKey = 'pushes' | 'moves' | 'imports' | 'nightly' | 'forms' | 'mailboxes';
export type HealthLine = { key: HealthKey; label: string; ok: boolean; words: string; href: string | null };

const DAY = 24 * 3600_000;
/** A form waiting longer than this turns the card amber (PLAN 4.7). */
export const FORM_LATE_MS = DAY;
/** Imports that failed one after another before it is worth a bell. */
export const IMPORTS_FAILED_IN_A_ROW = 2;
/** The setting that remembers which lines have rung, so each rings once until it clears. */
export const HEALTH_KEY = 'outreachHealth';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ago = (ms: number) => { const m = Math.round(ms / 60_000); return m < 90 ? plural(m, 'minute') : plural(Math.round(m / 60), 'hour'); };

/** Each line of the card, as it stands now. */
export async function outreachHealth(now = new Date()): Promise<HealthLine[]> {
  const [stuck, failedMoves, imports, nightly, lateForms, oldestForm, mail] = await Promise.all([
    prisma.bellwetherPush.count({ where: { state: 'PROCESSING', createdAt: { lt: new Date(now.getTime() - STUCK_MS) } } }),
    // A failed move is one that still needs someone: its contact is still here, not moved since.
    prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "SandboxMoveItem" i JOIN "SandboxContact" c ON c.id = i."sandboxContactId" JOIN "SandboxMove" m ON m.id = i."moveId"
      WHERE i.state = 'FAILED' AND c.status = 'ACTIVE' AND m."createdAt" >= ${new Date(now.getTime() - 7 * DAY)}`.then((r) => r[0]?.n ?? 0),
    prisma.setting.findUnique({ where: { key: IMPORT_STATUS_KEY } }),
    readNightly(),
    prisma.callLog.count({ where: { formDueAt: { not: null, lt: new Date(now.getTime() - FORM_LATE_MS) }, formDoneAt: null, discardedAt: null } }),
    prisma.callLog.findFirst({ where: { formDueAt: { not: null }, formDoneAt: null, discardedAt: null }, orderBy: { formDueAt: 'asc' }, select: { formDueAt: true } }),
    graphMailState(now),
  ]);
  const importState = (imports?.value ?? null) as { error?: string | null; failedInARow?: number } | null;
  const failedRuns = importState?.failedInARow ?? 0;
  const lines: HealthLine[] = [];
  lines.push(stuck
    ? { key: 'pushes', label: 'Bellwether pushes', ok: false, words: `${plural(stuck, 'push', 'pushes')} still being processed after 10 minutes.`, href: COLD_FROM_BELLWETHER_HREF }
    : { key: 'pushes', label: 'Bellwether pushes', ok: true, words: 'None stuck.', href: null });
  lines.push(failedMoves
    ? { key: 'moves', label: 'Moves to the CRM', ok: false, words: `${plural(failedMoves, 'move')} failed in the last 7 days and ${failedMoves === 1 ? 'waits' : 'wait'} for someone.`, href: COLD_MOVES_HREF }
    : { key: 'moves', label: 'Moves to the CRM', ok: true, words: 'None failed.', href: null });
  lines.push(failedRuns >= IMPORTS_FAILED_IN_A_ROW
    ? { key: 'imports', label: 'Call import', ok: false, words: `The last ${failedRuns} imports from Twilio failed${importState?.error ? `: ${importState.error}` : '.'}`, href: '/settings?tab=calling' }
    : { key: 'imports', label: 'Call import', ok: true, words: failedRuns ? 'The last import failed; the next one tries again.' : 'Running.', href: null });
  lines.push(nightlyLine(nightly, now));
  lines.push(lateForms
    ? { key: 'forms', label: 'Post-call forms', ok: false, words: `${plural(lateForms, 'form')} waiting more than 24 hours${oldestForm?.formDueAt ? `, the oldest for ${ago(now.getTime() - oldestForm.formDueAt.getTime())}` : ''}.`, href: `${COLD_CONTACT_BASE}?view=form_due` }
    : { key: 'forms', label: 'Post-call forms', ok: true, words: 'None waiting more than 24 hours.', href: null });
  lines.push(mail.failing
    ? { key: 'mailboxes', label: 'Outlook mailboxes', ok: false, words: `${plural(mail.failing, 'mailbox', 'mailboxes')} failing to read.`, href: '/settings?tab=signin' }
    : { key: 'mailboxes', label: 'Outlook mailboxes', ok: true, words: mail.enabled ? 'All read.' : 'Tracking is off.', href: null });
  return lines;
}

/** N087: still running after 30 minutes, or not run today once its hour has passed. */
function nightlyLine(m: Awaited<ReturnType<typeof readNightly>>, now: Date): HealthLine {
  const base = { key: 'nightly' as const, label: 'Nightly jobs', href: null };
  const running = m?.running?.startedAt ? now.getTime() - Date.parse(m.running.startedAt) : null;
  if (running !== null && running > NIGHTLY_SLOW_MS) return { ...base, ok: false, words: `Still running after ${ago(running)}.` };
  if (running !== null) return { ...base, ok: true, words: 'Running now.' };
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: workspaceTimezone(), hour: '2-digit', hour12: false }).format(now));
  const today = todayIn(workspaceTimezone(), now);
  // An hour's grace after the reconcile hour: the run takes a while to start and finish.
  if (hour > env().RECONCILE_HOUR && m?.day !== today) return { ...base, ok: false, words: m?.at ? 'Not run today.' : 'Never run. The worker runs them each night.' };
  const took = m?.durationMs != null ? ` in ${ago(m.durationMs)}` : '';
  return { ...base, ok: true, words: m?.day ? `Ran ${m.day === today ? 'today' : 'last night'}${took}.` : 'Not due yet.' };
}

/**
 * The worker's check: a line that turns amber rings every active admin's bell, once; it rings again
 * only after it has been fine in between. Returns the lines that rang.
 */
export async function ringHealth(now = new Date()): Promise<HealthKey[]> {
  const lines = await outreachHealth(now);
  const row = await prisma.setting.findUnique({ where: { key: HEALTH_KEY } });
  const open = { ...((row?.value as { open?: Record<string, string> } | null)?.open ?? {}) };
  const rang: HealthKey[] = [];
  for (const line of lines) {
    if (line.ok) { delete open[line.key]; continue; }
    if (open[line.key]) continue;
    open[line.key] = now.toISOString();
    rang.push(line.key);
  }
  if (rang.length) {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } });
    for (const key of rang) {
      const line = lines.find((l) => l.key === key)!;
      await notify(admins.map((a) => a.id), { kind: 'health_alert', payload: { key, label: line.label, text: line.words, href: line.href ?? COLD_OUTREACH_SETTINGS_HREF } });
    }
  }
  await prisma.setting.upsert({ where: { key: HEALTH_KEY }, create: { key: HEALTH_KEY, value: { open } }, update: { value: { open } } });
  return rang;
}
