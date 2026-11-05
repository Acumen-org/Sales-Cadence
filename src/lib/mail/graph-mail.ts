import { prisma } from '../db';
import { env } from '../env';
import { microsoftConfig } from '../auth/microsoft';
import { currentToken } from '../meetings/sharepoint-player';
import { isAutomaticReply } from '../engine/ingest';
import { normalizeEmail } from '../sandbox/normalize';
import { alertSuppressedAddresses, emailsToDoNotContact, recordBounce, recordColdReply, recordColdSent, systemNotice, type SeenMail } from './cold-email';

/**
 * Cold outreach emails close their steps through Microsoft Graph (plan section 12, decision 12). Reps
 * send from Outlook; Cadence reads the metadata of the sales mailboxes (addresses, subject, time,
 * conversation - never the body) with the application permission Mail.Read, limited by Exchange to
 * the sales mailboxes. Off unless GRAPH_MAIL_ENABLED=true. What one email does is cold-email.ts;
 * this file reads the mailboxes.
 *
 * Each folder of each mailbox keeps its place (MailboxCursor, N015): a first sync reads from the
 * moment tracking was switched on, 50 pages a run, and carries on from the page it reached the next
 * run; once in step it reads only what changed. When Microsoft says the link has expired, the folder
 * is read again from an hour before the last good run. Settings shows each folder's last success and
 * last error (N088).
 */

const FIELDS = 'internetMessageId,conversationId,subject,sentDateTime,receivedDateTime,from,toRecipients,ccRecipients,bccRecipients';
export const REFUSAL_KEY = 'graphMail.refused';
/** A first sync or a restart reads this many pages a run, then carries on from there (N015). */
export const PAGES_PER_RUN = 50;
/** Microsoft no longer knows the sync link (N015). */
const EXPIRED = /SyncStateNotFound|SyncStateInvalid|InvalidSyncState|resyncRequired|\b410\b/i;
/** A restart reads back to an hour before the last good run, so nothing in between is missed. */
const RESTART_MARGIN_MS = 3_600_000;
const FOLDERS = ['sentitems', 'inbox'] as const;
type Folder = (typeof FOLDERS)[number];
/** Who has a sales mailbox Cadence reads. */
const MAILBOX_ROLES = ['ADMIN', 'JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'] as const;
export const TRACKING_OFF = 'GRAPH_MAIL_ENABLED is not set on the server.';

type Address = { emailAddress?: { address?: string; name?: string } };
export type GraphMessage = { internetMessageId?: string; conversationId?: string; subject?: string | null; sentDateTime?: string; receivedDateTime?: string; from?: Address; toRecipients?: Address[]; ccRecipients?: Address[]; bccRecipients?: Address[]; '@removed'?: unknown };
type Fetch = typeof fetch;

export type GraphMailStats = { ran: boolean; reason?: string; mailboxes: number; sent: number; replies: number; autoReplies: number; bounces: number; possibleBounces: number; notices: number; alerts: number; closed: number; resets: number; errors: string[] };
const emptyStats = (): GraphMailStats => ({ ran: false, mailboxes: 0, sent: 0, replies: 0, autoReplies: 0, bounces: 0, possibleBounces: 0, notices: 0, alerts: 0, closed: 0, resets: 0, errors: [] });

const graphUrl = () => env().MICROSOFT_GRAPH_URL.replace(/\/+$/, '');
const addressesOf = (list: Address[] | undefined) => (list ?? []).map((a) => normalizeEmail(a.emailAddress?.address)).filter((a): a is string => Boolean(a));

/** Microsoft said no to a page: the status and its code, for telling an expired link from the rest. */
export class GraphRefused extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'GraphRefused';
  }
}

/** The first page of a folder's delta, from `since` on: mail before tracking started is never read. */
export function deltaStart(userKey: string, folder: Folder, since: Date): string {
  return `${graphUrl()}/v1.0/users/${encodeURIComponent(userKey)}/mailFolders/${folder}/messages/delta?$select=${FIELDS}&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}`;
}

/**
 * Up to `pages` pages of a folder's delta, from `from` (a first page, a page reached last run, or a
 * delta link). Returns the messages, and either the new delta link (in step) or the page to carry
 * on from next run.
 */
export async function readDelta(from: string, token: string, opts: { fetchImpl?: Fetch; pages?: number; label?: string } = {}): Promise<{ messages: GraphMessage[]; deltaLink: string | null; nextLink: string | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const messages: GraphMessage[] = [];
  let url: string | null = from;
  let deltaLink: string | null = null;
  for (let i = 0; url && i < (opts.pages ?? PAGES_PER_RUN); i++) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, prefer: 'odata.maxpagesize=100' }, signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => ({}))) as { value?: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string; error?: { code?: string; message?: string } };
    if (!res.ok) throw new GraphRefused(`Microsoft refused ${opts.label ?? 'a mailbox'}: ${body.error?.code ?? res.status} ${body.error?.message ?? ''}`.trim(), res.status, body.error?.code ?? null);
    messages.push(...(body.value ?? []).filter((m) => !m['@removed']));
    deltaLink = body['@odata.deltaLink'] ?? null;
    url = deltaLink ? null : body['@odata.nextLink'] ?? null;
  }
  return { messages, deltaLink, nextLink: deltaLink ? null : url };
}

const seen = (m: GraphMessage, userId: string, at: string | undefined): SeenMail | null => (m.internetMessageId ? { key: m.internetMessageId, conversationId: m.conversationId ?? null, subject: m.subject ?? null, at: new Date(at ?? Date.now()), mailboxUserId: userId, via: 'outlook' } : null);

/** A sent message: each cold contact it went to (cold-email.ts), and an alert for any address on the suppression list. */
export async function processSent(m: GraphMessage, userId: string, stats: GraphMailStats): Promise<void> {
  const mail = seen(m, userId, m.sentDateTime ?? m.receivedDateTime);
  if (!mail) return;
  const to = [...addressesOf(m.toRecipients), ...addressesOf(m.ccRecipients), ...addressesOf(m.bccRecipients)];
  const r = await recordColdSent(to, mail);
  stats.sent += r.recorded.length;
  stats.closed += r.closed;
  stats.alerts += r.alerts + (await alertSuppressedAddresses(to, mail, r.matched));
}

/** An inbox message: a bounce of an email sent from this mailbox, a mail system's other notice (ignored), or a cold contact's reply. */
export async function processInbox(m: GraphMessage, userId: string, stats: GraphMailStats): Promise<void> {
  const mail = seen(m, userId, m.receivedDateTime ?? m.sentDateTime);
  if (!mail) return;
  const from = normalizeEmail(m.from?.emailAddress?.address);
  const notice = systemNotice(from, m.subject);
  if (notice === 'bounce') {
    const r = await recordBounce(mail);
    stats.bounces += r.bounced.length;
    stats.possibleBounces += r.possible.length;
    return;
  }
  // A delay, a delivery receipt, a relay: nothing bounced and nobody replied (N059).
  if (notice === 'notice') { stats.notices++; return; }
  if (!from) return;
  const r = await recordColdReply(from, mail, isAutomaticReply(m.subject));
  stats.replies += r.replies;
  stats.autoReplies += r.autoReplies;
}

/** One folder of one mailbox, one run (N015). Every message read is processed: none is older than tracking. */
export async function syncFolder(user: { id: string; microsoftId: string }, folder: Folder, token: string, stats: GraphMailStats, opts: { fetchImpl?: Fetch; now?: Date; pages?: number } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const where = { userId_folder: { userId: user.id, folder } };
  const cursor = await prisma.mailboxCursor.findUnique({ where });
  const startedAt = cursor?.startedAt ?? now;
  const read = { ...opts, label: `${folder} of ${user.microsoftId}` };
  try {
    let reset = false;
    let page: Awaited<ReturnType<typeof readDelta>>;
    try {
      page = await readDelta(cursor?.nextLink ?? cursor?.deltaLink ?? deltaStart(user.microsoftId, folder, startedAt), token, read);
    } catch (err) {
      if (!(err instanceof GraphRefused) || !(cursor?.nextLink || cursor?.deltaLink) || !EXPIRED.test(`${err.status} ${err.code ?? ''} ${err.message}`)) throw err;
      // Microsoft no longer knows the link: read again from just before the last good run.
      const since = new Date((cursor.lastSuccessAt ?? cursor.startedAt ?? now).getTime() - RESTART_MARGIN_MS);
      page = await readDelta(deltaStart(user.microsoftId, folder, since), token, read);
      reset = true;
      stats.resets++;
    }
    for (const m of page.messages) await (folder === 'sentitems' ? processSent(m, user.id, stats) : processInbox(m, user.id, stats));
    const state = { startedAt, deltaLink: page.deltaLink ?? (reset ? null : cursor?.deltaLink ?? null), nextLink: page.nextLink, lastRunAt: now, lastSuccessAt: now, error: null, errorAt: null, resetAt: reset ? now : cursor?.resetAt ?? null };
    await prisma.mailboxCursor.upsert({ where, create: { userId: user.id, folder, ...state }, update: state });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    stats.errors.push(message);
    // Since when it has failed: the first error of a run of them.
    const failing = { startedAt, lastRunAt: now, error: message, errorAt: cursor?.error ? cursor.errorAt ?? now : now };
    await prisma.mailboxCursor.upsert({ where, create: { userId: user.id, folder, ...failing }, update: failing });
    if (/403|Access ?Denied|ErrorAccessDenied|Authorization_RequestDenied/i.test(message)) await recordRefusal(message);
  }
}

/** The worker's pass: each active sales user with a Microsoft account, Sent Items then Inbox. */
export async function runGraphMail(opts: { fetchImpl?: Fetch; now?: Date } = {}): Promise<GraphMailStats> {
  const stats = emptyStats();
  if (!env().GRAPH_MAIL_ENABLED) return { ...stats, reason: TRACKING_OFF };
  const config = await microsoftConfig();
  if (!config) return { ...stats, reason: 'No Microsoft app is configured (Settings > Sign-in).' };
  const token = await currentToken(config);
  if ('error' in token) { await recordRefusal(token.error); return { ...stats, reason: token.error }; }
  if (!token.roles.includes('Mail.Read')) { await recordRefusal('The app has no Mail.Read application permission yet.'); return { ...stats, reason: 'Mail.Read is not granted.' }; }
  stats.ran = true;
  const users = await prisma.user.findMany({ where: { active: true, microsoftId: { not: null }, role: { in: [...MAILBOX_ROLES] } }, select: { id: true, microsoftId: true } });
  for (const u of users) {
    stats.mailboxes++;
    for (const folder of FOLDERS) await syncFolder({ id: u.id, microsoftId: u.microsoftId! }, folder, token.value, stats, opts);
  }
  if (!stats.errors.length) await prisma.setting.deleteMany({ where: { key: REFUSAL_KEY } });
  return stats;
}

async function recordRefusal(message: string) {
  const value = { message: message.slice(0, 500), at: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key: REFUSAL_KEY }, create: { key: REFUSAL_KEY, value }, update: { value } });
}

/** Where one folder of one mailbox is: in step, part way through its first read, failing, or not read yet. */
export type FolderState = { folder: Folder; state: 'in_step' | 'first_sync' | 'failing' | 'not_started'; lastRunAt: Date | null; lastSuccessAt: Date | null; error: string | null; errorAt: Date | null; resetAt: Date | null };
export type MailboxState = { userId: string; name: string; email: string; signedIn: boolean; folders: FolderState[]; failing: boolean };

/**
 * For Settings > Sign-in (N015, N088): whether tracking is on and, if not, why; Microsoft's last
 * refusal; each sales mailbox with each folder's last success and last error; and how many emails
 * went to people who must not be contacted in the last 30 days (N016).
 */
export async function graphMailState(now = new Date()): Promise<{ enabled: boolean; why: string | null; refusal: string | null; lastRunAt: Date | null; mailboxes: MailboxState[]; failing: number; emailsToDoNotContact: number }> {
  const enabled = env().GRAPH_MAIL_ENABLED;
  const [refused, cursors, users, config, alerts] = await Promise.all([
    prisma.setting.findUnique({ where: { key: REFUSAL_KEY } }),
    prisma.mailboxCursor.findMany(),
    prisma.user.findMany({ where: { active: true, role: { in: [...MAILBOX_ROLES] } }, select: { id: true, name: true, email: true, microsoftId: true }, orderBy: { name: 'asc' } }),
    enabled ? microsoftConfig() : Promise.resolve(null),
    emailsToDoNotContact(new Date(now.getTime() - 30 * 86_400_000)),
  ]);
  const why = !enabled ? TRACKING_OFF : !config ? 'No Microsoft app is saved yet: save it above.' : null;
  const mailboxes = users.map((u) => {
    const folders = FOLDERS.map((folder): FolderState => {
      const c = cursors.find((x) => x.userId === u.id && x.folder === folder);
      const state = !c ? 'not_started' : c.error ? 'failing' : c.deltaLink && !c.nextLink ? 'in_step' : 'first_sync';
      return { folder, state, lastRunAt: c?.lastRunAt ?? null, lastSuccessAt: c?.lastSuccessAt ?? null, error: c?.error ?? null, errorAt: c?.errorAt ?? null, resetAt: c?.resetAt ?? null };
    });
    return { userId: u.id, name: u.name, email: u.email, signedIn: Boolean(u.microsoftId), folders, failing: folders.some((f) => f.state === 'failing') };
  });
  const last = cursors.map((c) => c.lastRunAt).filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return { enabled, why, refusal: (refused?.value as { message?: string } | null)?.message ?? null, lastRunAt: last, mailboxes, failing: mailboxes.filter((m) => m.failing).length, emailsToDoNotContact: alerts };
}

/**
 * Whether Cadence reads each of these reps' sent mail now, so an email step closes itself when they
 * send it (N088): tracking on, no refusal from Microsoft, signed in with Microsoft, and their Sent
 * Items read without an error.
 */
export async function mailTrackedFor(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length || !env().GRAPH_MAIL_ENABLED) return new Set();
  const [refused, users] = await Promise.all([
    prisma.setting.findUnique({ where: { key: REFUSAL_KEY }, select: { key: true } }),
    prisma.user.findMany({ where: { id: { in: ids }, active: true, microsoftId: { not: null } }, select: { id: true } }),
  ]);
  if (refused || !users.length) return new Set();
  const cursors = await prisma.mailboxCursor.findMany({ where: { userId: { in: users.map((u) => u.id) }, folder: 'sentitems', error: null, OR: [{ deltaLink: { not: null } }, { nextLink: { not: null } }] }, select: { userId: true } });
  return new Set(cursors.map((c) => c.userId));
}

/** What an email row tells its rep (N088). */
export const emailCloseWords = (tracked: boolean) => (tracked ? 'Closes itself when you send from Outlook.' : 'Click Done after sending.');
