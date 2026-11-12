import { prisma } from '../db';
import { getSettings } from '../settings';
import { pollFeed } from './console';
import { closeConnectStepsAlreadyDone, processPendingEvents } from './events';
import { closeForDoNotContact, followOwners, openFollowUp, type LinkedInSubject } from './follow-ups';

const DAY = 86_400_000;

/**
 * Requests still waiting after 14 days (owner, 12 Nov 2026): "Withdraw the connection request", once per
 * request. A request sent again after a withdrawal starts its own 14 days. Returns how many opened.
 */
export async function openWithdrawTasks(now = new Date()): Promise<number> {
  const { linkedin } = await getSettings();
  if (!linkedin.enabled) return 0;
  const before = new Date(now.getTime() - linkedin.withdrawAfterDays * DAY);
  const links = await prisma.linkedInLink.findMany({ where: { status: 'PENDING', invitedByUs: true, invitedAt: { lte: before }, OR: [{ personId: { not: null } }, { sandboxContactId: { not: null } }] }, take: 500 });
  let n = 0;
  for (const link of links) {
    // This request had its withdrawal task already (done, dismissed or open).
    if (await prisma.linkedInFollowUp.count({ where: { linkId: link.id, kind: 'WITHDRAW', triggeredAt: { gte: link.invitedAt! } } })) continue;
    const subject: LinkedInSubject = link.personId ? { personId: link.personId } : { sandboxContactId: link.sandboxContactId! };
    const triggeredAt = new Date(link.invitedAt!.getTime() + linkedin.withdrawAfterDays * DAY);
    if (await openFollowUp({ kind: 'WITHDRAW', trigger: 'pending', triggeredAt, link, subject }, now)) n++;
  }
  return n;
}

let feedAt = 0;
let rulesAt = 0;

/**
 * The worker's LinkedIn pass, each tick: read the Console's feed (every 2 minutes), process new events,
 * and every 15 minutes the rules that run on time: withdrawals due, connect steps already done, tasks
 * that follow their person's owner, and tasks for people who must not be contacted any more.
 */
export async function runLinkedInPass(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const t = now.getTime();
  if (t >= feedAt) {
    feedAt = t + 120_000;
    const feed = await pollFeed(now);
    if (feed.stored || feed.error) out.feed = feed;
  }
  const processed = await processPendingEvents(now);
  if (Object.keys(processed).length) out.processed = processed;
  const { linkedin } = await getSettings();
  if (linkedin.enabled && t >= rulesAt) {
    rulesAt = t + 15 * 60_000;
    const withdraw = await openWithdrawTasks(now);
    const steps = await closeConnectStepsAlreadyDone(null, now);
    const owners = await followOwners(now);
    const dnc = await closeForDoNotContact(now);
    if (withdraw || steps || owners || dnc) out.rules = { withdraw, steps, owners, dnc };
  }
  return out;
}
