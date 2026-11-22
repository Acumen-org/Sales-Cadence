import { prisma } from '../db';
import { env } from '../env';
import { getSettings, type EmailSettings } from '../settings';
import { bellWords, namesFor, notificationScope, type NotificationKind } from '../notifications';
import { waitingForMe } from '../meetings/approval';
import { safeTimezone, todayIn } from '../dates';
import { renderBellEmail, type EmailItem, type EmailExtras } from './template';
import { sendMail } from './send';

/*
 * The bell by email (owner, 21 Nov 2026). Each person gets only what is already in their own bell,
 * which only ever holds what they may see and are concerned with.
 *
 *   smart (the default): what needs action is emailed a few minutes after it rings, in work hours,
 *     unless it was read or settled in Cadence by then; everything else waits for the morning summary.
 *   digest: the morning summary only.     off: nothing.
 *
 * The morning summary goes out on weekdays at the set hour in the person's own time zone, once a day,
 * with what came in since the last one and what is waiting for them. A notification is looked at once:
 * `emailedAt` is set when it is sent, or when the pass decides it never will be (read, settled, the
 * person's emails off, a week old). A failed send is tried again after a pause.
 */

/** Needs someone soon: emailed within minutes, in work hours. */
export const URGENT_KINDS: ReadonlySet<string> = new Set<NotificationKind>(['meeting_approval', 'meeting_declined', 'reply', 'bounce', 'possible_bounce', 'compliance_alert', 'call_flag', 'health_alert', 'campaign_launch_failed']);
export const EMAIL_MODES = ['smart', 'digest', 'off'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

const STALE_MS = 7 * 86_400_000;
const RETRY_AFTER_MS = 15 * 60_000;
const DIGEST_LIMIT = 30;
/** Marks a refusal that would refuse every email: the pass pauses for RETRY_AFTER_MS. */
const BLOCKED = '[Paused] ';
class Blocked extends Error {}

export type BellEmailStats = { ran: boolean; reason?: string; instant: number; digests: number; skipped: number; failed: number };

/** The hour and weekday where the person is. */
export function localClock(now: Date, timezone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: safeTimezone(timezone), hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Mon');
  return { hour, weekday };
}
const workday = (weekday: number) => weekday >= 1 && weekday <= 5;
export const inWorkHours = (now: Date, timezone: string, s: Pick<EmailSettings, 'workStartHour' | 'workEndHour'>) => { const c = localClock(now, timezone); return workday(c.weekday) && c.hour >= s.workStartHour && c.hour < s.workEndHour; };
/** The summary goes in the two hours from its hour; one missed (Cadence was down) waits for the next day's. */
export const DIGEST_WINDOW_HOURS = 2;
export const digestDue = (now: Date, timezone: string, s: Pick<EmailSettings, 'digestHour'>, lastDigestOn: string | null) => { const c = localClock(now, timezone); return workday(c.weekday) && c.hour >= s.digestHour && c.hour < s.digestHour + DIGEST_WINDOW_HOURS && lastDigestOn !== todayIn(safeTimezone(timezone), now); };
const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'there';

type Row = Awaited<ReturnType<typeof pendingRows>>[number];
function pendingRows(since: Date) {
  return prisma.notification.findMany({ where: { emailedAt: null, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 2000 });
}

async function mark(ids: string[], at: Date) {
  if (ids.length) await prisma.notification.updateMany({ where: { id: { in: ids }, emailedAt: null }, data: { emailedAt: at } });
}

async function itemsFor(rows: Row[], viewer: { role: import('@prisma/client').Role }): Promise<EmailItem[]> {
  const names = await namesFor(rows);
  return rows.map((r) => ({ ...bellWords(r, names, viewer), at: r.createdAt }));
}

export async function runBellEmail(now = new Date(), send: typeof sendMail = sendMail): Promise<BellEmailStats> {
  const stats: BellEmailStats = { ran: false, instant: 0, digests: 0, skipped: 0, failed: 0 };
  const { email: s } = await getSettings();
  if (!s.enabled || !s.senderMailbox) return { ...stats, reason: 'Emails are off (Settings > Meetings and email).' };
  // Microsoft refused outright a moment ago (no permission, no such mailbox): wait, rather than fail for everyone.
  const blocked = await prisma.notificationEmail.findFirst({ where: { status: 'FAILED', error: { startsWith: BLOCKED } , createdAt: { gte: new Date(now.getTime() - RETRY_AFTER_MS) } }, select: { error: true } });
  if (blocked) return { ...stats, reason: blocked.error ?? 'Microsoft refused.' };
  stats.ran = true;
  const appUrl = env().APP_URL;

  // A week old and never sent: old news, never emailed.
  const stale = await prisma.notification.updateMany({ where: { emailedAt: null, createdAt: { lt: new Date(now.getTime() - STALE_MS) } }, data: { emailedAt: now } });
  stats.skipped += stale.count;

  const rows = await pendingRows(new Date(now.getTime() - STALE_MS));
  const byUser = new Map<string, Row[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  // Everyone with something pending, and everyone who may get a morning summary of what is waiting.
  const users = await prisma.user.findMany({
    where: { OR: [{ id: { in: [...byUser.keys()] } }, { active: true, emailNotifications: { not: 'off' } }] },
    select: { id: true, name: true, email: true, role: true, active: true, timezone: true, twentyMemberId: true, pods: { select: { podId: true } }, emailNotifications: true, lastDigestOn: true, notificationsReadAt: true },
  });

  const recentFailures = new Set((await prisma.notificationEmail.findMany({ where: { status: 'FAILED', createdAt: { gte: new Date(now.getTime() - RETRY_AFTER_MS) } }, select: { userId: true } })).map((f) => f.userId));

  try {
    for (const u of users) await onePerson(u);
  } catch (err) {
    if (!(err instanceof Blocked)) throw err;
    stats.failed++;
    stats.reason = err.message;
  }
  return stats;

  async function onePerson(u: (typeof users)[number]) {
    const mine = byUser.get(u.id) ?? [];
    const mode = (EMAIL_MODES as readonly string[]).includes(u.emailNotifications) ? (u.emailNotifications as EmailMode) : 'smart';
    // Nothing for someone whose emails are off, who left, or who has no address.
    if (!u.active || mode === 'off' || !u.email.includes('@')) { await mark(mine.map((r) => r.id), now); stats.skipped += mine.length; return; }
    // Read or answered in Cadence already: no need to email it.
    const seen = mine.filter((r) => r.readAt || r.resolution || (u.notificationsReadAt && r.createdAt <= u.notificationsReadAt));
    await mark(seen.map((r) => r.id), now);
    stats.skipped += seen.length;
    let open = mine.filter((r) => !seen.includes(r));
    if (recentFailures.has(u.id)) return;
    const tz = safeTimezone(u.timezone);
    const viewer = { role: u.role };

    // Urgent, a few minutes after it rang, in work hours; when the summary is due now, it carries them.
    const summaryNow = digestDue(now, tz, s, u.lastDigestOn);
    if (mode === 'smart' && !summaryNow && inWorkHours(now, tz, s)) {
      const due = open.filter((r) => URGENT_KINDS.has(r.kind) && r.createdAt.getTime() <= now.getTime() - s.urgentDelayMinutes * 60_000);
      if (due.length) {
        const sent = await deliver(u, 'instant', due, await itemsFor(due, viewer), {}, s, appUrl, tz, now, send);
        if (sent) { stats.instant++; open = open.filter((r) => !due.includes(r)); } else { stats.failed++; return; }
      }
    }

    // The morning summary: whatever is still open, and what is waiting.
    if (summaryNow) {
      const today = todayIn(tz, now);
      const actor = { id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) };
      const last = await prisma.notificationEmail.findFirst({ where: { userId: u.id, kind: 'digest', status: 'SENT' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      // CRM replies since the last summary that were not read in the bell since.
      const lastSummary = last?.createdAt ?? new Date(now.getTime() - 86_400_000);
      const since = u.notificationsReadAt && u.notificationsReadAt > lastSummary ? u.notificationsReadAt : lastSummary;
      const [approvalsWaiting, crmReplies] = await Promise.all([
        waitingForMe(actor),
        prisma.touch.count({ where: { ...notificationScope({ id: u.id, twentyMemberId: u.twentyMemberId }, now), createdAt: { gt: since } } }),
      ]);
      const extras: EmailExtras = { approvalsWaiting, crmReplies };
      const list = open.slice(-DIGEST_LIMIT).reverse();
      if (list.length || approvalsWaiting || crmReplies) {
        const sent = await deliver(u, 'digest', open, await itemsFor(list, viewer), extras, s, appUrl, tz, now, send);
        if (!sent) { stats.failed++; return; }
        stats.digests++;
      }
      await prisma.user.update({ where: { id: u.id }, data: { lastDigestOn: today } });
    }
  }
}

/** Send one email and record it; the notifications it carried are marked as emailed. */
async function deliver(u: { id: string; name: string; email: string }, kind: 'instant' | 'digest', rows: Row[], items: EmailItem[], extras: EmailExtras, s: EmailSettings, appUrl: string, timezone: string, now: Date, send: typeof sendMail): Promise<boolean> {
  const mail = renderBellEmail({ kind, firstName: firstName(u.name), items, extras, appUrl, timezone });
  const r = await send({ from: s.senderMailbox, to: u.email, subject: mail.subject, html: mail.html, text: mail.text });
  await prisma.notificationEmail.create({ data: { userId: u.id, kind, subject: mail.subject, notificationIds: rows.map((x) => x.id), status: r.ok ? 'SENT' : 'FAILED', error: r.ok ? null : `${r.permanent ? BLOCKED : ''}${r.error}`, createdAt: now } });
  if (r.ok) await mark(rows.map((x) => x.id), now);
  if (!r.ok && r.permanent) throw new Blocked(r.error);
  return r.ok;
}

/** Settings > Meetings and email: a test to the admin's own address. */
export async function sendTestEmail(user: { id: string; name: string; email: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const { email: s } = await getSettings();
  if (!s.senderMailbox) return { ok: false, error: 'Name the mailbox Cadence sends from first, and save.' };
  const sample: EmailItem[] = [
    { kind: 'meeting_approval', name: 'Intro call with Acme', company: null, title: 'Karson added a meeting with no recording, booked by Karson Junior. Approve or decline it.', detail: null, href: '/meetings/approval', linkLabel: 'Open Approval', at: new Date() },
    { kind: 'reply', name: 'Pat One', company: 'Acme', title: 'Replied to your email: "Thanks, Thursday works"', detail: null, href: '/home', linkLabel: 'Open their emails', at: new Date() },
  ];
  const mail = renderBellEmail({ kind: 'test', firstName: firstName(user.name), items: sample, extras: { approvalsWaiting: 2 }, appUrl: env().APP_URL, timezone: 'America/Chicago' });
  const r = await sendMail({ from: s.senderMailbox, to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
  await prisma.notificationEmail.create({ data: { userId: user.id, kind: 'test', subject: mail.subject, status: r.ok ? 'SENT' : 'FAILED', error: r.ok ? null : r.error } });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
