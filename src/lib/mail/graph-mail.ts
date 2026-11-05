import { prisma } from '../db';
import { env } from '../env';
import { SYSTEM_ACTOR } from '../audit';
import { getSettings } from '../settings';
import { microsoftConfig } from '../auth/microsoft';
import { currentToken } from '../meetings/sharepoint-player';
import { closeFromTouch } from '../engine/observed-evidence';
import { markReplied, OCCUPYING_STATUSES } from '../engine/enrollment';
import { skipTask } from '../engine/tasks';
import { isAutomaticReply } from '../engine/ingest';
import { normalizeEmail } from '../sandbox/normalize';
import { findSuppressed } from '../sandbox/suppression';

/**
 * Sandbox emails close their steps through Microsoft Graph (plan section 12, decision 12). Reps send
 * from Outlook; Cadence reads the metadata of the sales mailboxes (addresses, subject, time,
 * conversation - never the body) with the application permission Mail.Read, limited by Exchange to
 * the sales mailboxes. Off unless GRAPH_MAIL_ENABLED=true. Mail that matches no sandbox contact is
 * never stored.
 */

const FIELDS = 'internetMessageId,conversationId,subject,sentDateTime,receivedDateTime,from,toRecipients,ccRecipients,bccRecipients';
export const REFUSAL_KEY = 'graphMail.refused';
const BOUNCE_FROM = /^(postmaster|mailer-daemon|microsoftexchange[0-9a-f]*)@/i;
const BOUNCE_SUBJECT = /^(undeliverable|delivery has failed|mail delivery (failed|subsystem)|delivery status notification|returned mail)/i;

type Address = { emailAddress?: { address?: string; name?: string } };
export type GraphMessage = { internetMessageId?: string; conversationId?: string; subject?: string | null; sentDateTime?: string; receivedDateTime?: string; from?: Address; toRecipients?: Address[]; ccRecipients?: Address[]; bccRecipients?: Address[]; '@removed'?: unknown };
type Fetch = typeof fetch;

export type GraphMailStats = { ran: boolean; reason?: string; mailboxes: number; sent: number; replies: number; autoReplies: number; bounces: number; closed: number; errors: string[] };

const graphUrl = () => env().MICROSOFT_GRAPH_URL.replace(/\/+$/, '');
const addressesOf = (list: Address[] | undefined) => (list ?? []).map((a) => normalizeEmail(a.emailAddress?.address)).filter((a): a is string => Boolean(a));

/** Every page of a mailbox folder's delta, from the saved deltaLink (or from now on the first run). */
export async function readDelta(userKey: string, folder: 'sentitems' | 'inbox', start: string | null, token: string, fetchImpl: Fetch = fetch): Promise<{ messages: GraphMessage[]; deltaLink: string | null }> {
  const first = start ?? `${graphUrl()}/v1.0/users/${encodeURIComponent(userKey)}/mailFolders/${folder}/messages/delta?$select=${FIELDS}`;
  const messages: GraphMessage[] = [];
  let url: string | null = first;
  let deltaLink: string | null = null;
  for (let i = 0; url && i < 50; i++) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, prefer: 'odata.maxpagesize=100' }, signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => ({}))) as { value?: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string; error?: { code?: string; message?: string } };
    if (!res.ok) throw new Error(`Microsoft refused ${folder} of ${userKey}: ${body.error?.code ?? res.status} ${body.error?.message ?? ''}`.trim());
    messages.push(...(body.value ?? []).filter((m) => !m['@removed']));
    url = body['@odata.nextLink'] ?? null;
    deltaLink = body['@odata.deltaLink'] ?? deltaLink;
  }
  return { messages, deltaLink };
}

/** The ACTIVE sandbox contacts behind any of these addresses. */
async function contactsByEmail(addresses: string[]) {
  if (!addresses.length) return [];
  return prisma.sandboxContact.findMany({ where: { status: 'ACTIVE', OR: [{ email: { in: addresses } }, { additionalEmails: { hasSome: addresses } }] }, select: { id: true, email: true, additionalEmails: true, phone: true, phoneType: true, additionalPhones: true, linkedinUrl: true, bellwetherContactId: true, bellwetherAliases: true } });
}

/** A sent message to sandbox contacts: stored, a touch, and the open email step it counts for. */
export async function processSent(m: GraphMessage, userId: string, stats: GraphMailStats): Promise<void> {
  const id = m.internetMessageId;
  if (!id) return;
  const at = new Date(m.sentDateTime ?? m.receivedDateTime ?? Date.now());
  const contacts = await contactsByEmail([...addressesOf(m.toRecipients), ...addressesOf(m.ccRecipients), ...addressesOf(m.bccRecipients)]);
  const { matching } = await getSettings();
  for (const c of contacts) {
    if (await findSuppressed([{ kind: 'email', value: c.email ?? '' }].filter((k) => k.value) as { kind: 'email'; value: string }[])) continue;
    const existing = await prisma.sandboxEmail.findUnique({ where: { internetMessageId_sandboxContactId: { internetMessageId: id, sandboxContactId: c.id } } });
    if (existing) continue;
    const externalId = `graph:${id}:sbx:${c.id}`;
    const touch = await prisma.touch.upsert({ where: { externalId }, create: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: at, summary: `Email sent: ${m.subject ?? '(no subject)'}`, externalId, actorUserId: userId, audience: 'SANDBOX' }, update: {} });
    const closed = await closeFromTouch({ sandboxContactId: c.id, types: ['EMAIL'], touch: { externalId, channel: 'EMAIL', occurredAt: at, summary: touch.summary }, source: 'OBSERVED_MESSAGE', matching, ctx: { actor: SYSTEM_ACTOR } });
    await prisma.sandboxEmail.create({ data: { sandboxContactId: c.id, userId, kind: 'SENT', internetMessageId: id, conversationId: m.conversationId ?? null, subject: m.subject ?? null, at, touchId: touch.id, taskId: closed.code === 'completed' ? closed.taskId ?? null : null } });
    // An email next action due today or earlier is done by the email too.
    const due = await prisma.nextAction.findFirst({ where: { sandboxContactId: c.id, personId: null, state: 'OPEN', action: 'EMAIL', dueDate: { lte: at.toISOString().slice(0, 10) } } });
    if (due) await prisma.nextAction.update({ where: { id: due.id }, data: { state: 'DONE', doneCount: { increment: 1 }, lastDoneAt: at, closedAt: at } });
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { lastActivityAt: at } });
    stats.sent++;
    if (closed.code === 'completed') stats.closed++;
  }
}

/** An inbox message: a bounce of a sandbox email, or a sandbox contact's reply (or auto-reply). */
export async function processInbox(m: GraphMessage, userId: string, stats: GraphMailStats): Promise<void> {
  const id = m.internetMessageId;
  if (!id) return;
  const at = new Date(m.receivedDateTime ?? m.sentDateTime ?? Date.now());
  const from = normalizeEmail(m.from?.emailAddress?.address);
  const subject = m.subject ?? '';
  if ((from && BOUNCE_FROM.test(from)) || BOUNCE_SUBJECT.test(subject)) {
    await processBounce(m, at, stats);
    return;
  }
  if (!from) return;
  const contacts = await contactsByEmail([from]);
  for (const c of contacts) {
    const existing = await prisma.sandboxEmail.findUnique({ where: { internetMessageId_sandboxContactId: { internetMessageId: id, sandboxContactId: c.id } } });
    if (existing) continue;
    const automatic = isAutomaticReply(subject);
    const externalId = `graph:${id}:sbx:${c.id}`;
    const touch = await prisma.touch.upsert({ where: { externalId }, create: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: at, summary: `${automatic ? 'Auto-reply' : 'Reply'}: ${subject || '(no subject)'}`, externalId, audience: 'SANDBOX' }, update: {} });
    await prisma.sandboxEmail.create({ data: { sandboxContactId: c.id, userId, kind: automatic ? 'AUTO_REPLY' : 'REPLY', internetMessageId: id, conversationId: m.conversationId ?? null, subject: subject || null, at, touchId: touch.id } });
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { lastActivityAt: at } });
    if (automatic) { stats.autoReplies++; continue; }
    stats.replies++;
    const running = await prisma.enrollment.findMany({ where: { sandboxContactId: c.id, personId: null, status: { in: OCCUPYING_STATUSES } }, select: { id: true } });
    for (const e of running) await markReplied(e.id, { at, evidenceId: externalId, actor: SYSTEM_ACTOR });
  }
}

/**
 * A bounce, matched to the email it answers by conversation, else by subject within 72 hours.
 * Without the body this is a judgement: several possible matches are flagged, not guessed.
 */
async function processBounce(m: GraphMessage, at: Date, stats: GraphMailStats): Promise<void> {
  let sent = m.conversationId ? await prisma.sandboxEmail.findMany({ where: { kind: 'SENT', conversationId: m.conversationId }, select: { sandboxContactId: true } }) : [];
  if (!sent.length) {
    const original = (m.subject ?? '').replace(/^\s*(undeliverable|delivery has failed[^:]*|returned mail[^:]*)\s*:\s*/i, '').trim();
    if (original) sent = await prisma.sandboxEmail.findMany({ where: { kind: 'SENT', subject: original, at: { gte: new Date(at.getTime() - 72 * 3600_000), lte: at } }, select: { sandboxContactId: true } });
  }
  const contactIds = [...new Set(sent.map((s) => s.sandboxContactId))];
  if (contactIds.length !== 1) {
    if (contactIds.length > 1) for (const id of contactIds) await prisma.sandboxContact.update({ where: { id }, data: { tags: { push: 'bounce:check' } } });
    return;
  }
  const contactId = contactIds[0];
  const { rules } = await getSettings();
  await prisma.sandboxEmail.upsert({ where: { internetMessageId_sandboxContactId: { internetMessageId: m.internetMessageId!, sandboxContactId: contactId } }, create: { sandboxContactId: contactId, kind: 'BOUNCE', internetMessageId: m.internetMessageId!, conversationId: m.conversationId ?? null, subject: m.subject ?? null, at }, update: {} });
  await prisma.sandboxContact.update({ where: { id: contactId }, data: { badEmail: true } });
  // The contact's email steps are skipped with the bounced reason, as a skip by hand would.
  const open = await prisma.task.findMany({ where: { state: 'PENDING', action: 'EMAIL', enrollment: { sandboxContactId: contactId, personId: null } }, select: { id: true } });
  const label = rules.skipReasons.find((r) => r.key === 'bounced')?.label ?? 'Email bounced';
  for (const t of open) await skipTask({ taskId: t.id, reason: label }, { actor: SYSTEM_ACTOR });
  stats.bounces++;
}

/** The worker's pass: each active sales user with a Microsoft account, Sent Items then Inbox. */
export async function runGraphMail(opts: { fetchImpl?: Fetch; now?: Date } = {}): Promise<GraphMailStats> {
  const stats: GraphMailStats = { ran: false, mailboxes: 0, sent: 0, replies: 0, autoReplies: 0, bounces: 0, closed: 0, errors: [] };
  if (!env().GRAPH_MAIL_ENABLED) return { ...stats, reason: 'GRAPH_MAIL_ENABLED is not set.' };
  const config = await microsoftConfig();
  if (!config) return { ...stats, reason: 'No Microsoft app is configured (Settings > Sign-in).' };
  const token = await currentToken(config);
  if ('error' in token) { await recordRefusal(token.error); return { ...stats, reason: token.error }; }
  if (!token.roles.includes('Mail.Read')) { await recordRefusal('The app has no Mail.Read application permission yet.'); return { ...stats, reason: 'Mail.Read is not granted.' }; }
  stats.ran = true;
  const users = await prisma.user.findMany({ where: { active: true, microsoftId: { not: null }, role: { in: ['ADMIN', 'JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'] } }, select: { id: true, microsoftId: true, email: true } });
  for (const u of users) {
    stats.mailboxes++;
    for (const folder of ['sentitems', 'inbox'] as const) {
      const cursor = await prisma.mailboxCursor.findUnique({ where: { userId_folder: { userId: u.id, folder } } });
      try {
        const { messages, deltaLink } = await readDelta(u.microsoftId!, folder, cursor?.deltaLink ?? null, token.value, opts.fetchImpl);
        // The first run only sets the cursor: tracking starts the day it is switched on.
        if (cursor?.deltaLink) for (const m of messages) await (folder === 'sentitems' ? processSent(m, u.id, stats) : processInbox(m, u.id, stats));
        await prisma.mailboxCursor.upsert({ where: { userId_folder: { userId: u.id, folder } }, create: { userId: u.id, folder, deltaLink, lastRunAt: opts.now ?? new Date(), error: null }, update: { deltaLink: deltaLink ?? cursor?.deltaLink ?? null, lastRunAt: opts.now ?? new Date(), error: null } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stats.errors.push(message);
        await prisma.mailboxCursor.upsert({ where: { userId_folder: { userId: u.id, folder } }, create: { userId: u.id, folder, error: message.slice(0, 500), lastRunAt: opts.now ?? new Date() }, update: { error: message.slice(0, 500), lastRunAt: opts.now ?? new Date() } });
        if (/403|Access ?Denied|ErrorAccessDenied|Authorization_RequestDenied/i.test(message)) await recordRefusal(message);
      }
    }
  }
  if (!stats.errors.length) await prisma.setting.deleteMany({ where: { key: REFUSAL_KEY } });
  return stats;
}

async function recordRefusal(message: string) {
  const value = { message: message.slice(0, 500), at: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key: REFUSAL_KEY }, create: { key: REFUSAL_KEY, value }, update: { value } });
}

/** For Settings > Sign-in: whether reading the sales mailboxes works, and Microsoft's last refusal. */
export async function graphMailState(): Promise<{ enabled: boolean; refusal: string | null; lastRunAt: Date | null; mailboxes: number }> {
  const [refused, cursors] = await Promise.all([prisma.setting.findUnique({ where: { key: REFUSAL_KEY } }), prisma.mailboxCursor.findMany({ select: { lastRunAt: true, userId: true } })]);
  const last = cursors.map((c) => c.lastRunAt).filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return { enabled: env().GRAPH_MAIL_ENABLED, refusal: (refused?.value as { message?: string } | null)?.message ?? null, lastRunAt: last, mailboxes: new Set(cursors.map((c) => c.userId)).size };
}
