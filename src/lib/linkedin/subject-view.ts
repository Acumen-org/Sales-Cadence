import type { LinkedInLinkStatus } from '@prisma/client';
import { prisma } from '../db';
import { formatLocalDate, toLocalDate, todayIn, type LocalDate } from '../dates';
import { followUpLabel, subjectWhere, type LinkedInSubject } from './follow-ups';
import { consoleProfileLink, consoleUrl } from './keys';

/**
 * The LinkedIn card on a person's page and a cold contact's page: where each firm account stands with
 * them, as the Console last reported it, and the LinkedIn tasks still open. Only reads.
 */

export type LinkedInTaskView = { id: string; label: string; dueDate: LocalDate | null; overdue: boolean; owner: string | null };

export type LinkedInAccountView = {
  accountId: string;
  accountName: string;
  status: LinkedInLinkStatus;
  /** "Request sent 3 Nov by Alisa", "Connected since 6 Nov", "Request withdrawn 20 Nov". */
  statusLine: string;
  /** "Sent again once"; null when never sent again. */
  resendLine: string | null;
  lastSent: string | null;
  lastReply: string | null;
  /** Open in Console; null when the Console's address is not configured. */
  consoleHref: string | null;
  tasks: LinkedInTaskView[];
};

export type LinkedInSubjectView = { accounts: LinkedInAccountView[] };

const day = (d: Date, timezone: string) => formatLocalDate(toLocalDate(d, timezone));

export function resendWords(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? 'Sent again once' : n === 2 ? 'Sent again twice' : `Sent again ${n} times`;
}

export function statusWords(
  link: { status: LinkedInLinkStatus; invitedByUs: boolean; invitedAt: Date | null; acceptedAt: Date | null; withdrawnAt: Date | null; createdAt: Date },
  invitedBy: string | null,
  timezone: string,
): string {
  if (link.status === 'ACCEPTED') return link.acceptedAt ? `Connected since ${day(link.acceptedAt, timezone)}` : 'Connected';
  if (link.status === 'WITHDRAWN') return link.withdrawnAt ? `Request withdrawn ${day(link.withdrawnAt, timezone)}` : 'Request withdrawn';
  if (!link.invitedByUs) return `They asked to connect ${day(link.invitedAt ?? link.createdAt, timezone)}`;
  return `Request sent${link.invitedAt ? ` ${day(link.invitedAt, timezone)}` : ''}${invitedBy ? ` by ${invitedBy}` : ''}`;
}

export async function linkedinSubjectView(subject: LinkedInSubject, timezone: string, now: Date = new Date()): Promise<LinkedInSubjectView> {
  const links = await prisma.linkedInLink.findMany({
    where: subjectWhere(subject),
    include: { followUps: { where: { state: 'OPEN' }, include: { fo: { select: { name: true } } }, orderBy: { createdAt: 'asc' } } },
  });
  if (!links.length) return { accounts: [] };
  const [accounts, inviters] = await Promise.all([
    prisma.linkedInAccount.findMany({ where: { id: { in: [...new Set(links.map((l) => l.accountId))] } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(links.flatMap((l) => (l.invitedByUserId ? [l.invitedByUserId] : [])))] } }, select: { id: true, name: true } }),
  ]);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const inviterName = new Map(inviters.map((u) => [u.id, u.name]));
  const today = todayIn(timezone, now);
  const hasConsole = consoleUrl() !== null;
  return {
    accounts: links
      .map<LinkedInAccountView>((l) => ({
        accountId: l.accountId,
        accountName: accountName.get(l.accountId) ?? l.accountId,
        status: l.status,
        statusLine: statusWords(l, l.invitedByUserId ? inviterName.get(l.invitedByUserId) ?? null : null, timezone),
        resendLine: resendWords(l.resends),
        lastSent: l.lastSentAt ? day(l.lastSentAt, timezone) : null,
        lastReply: l.lastReplyAt ? day(l.lastReplyAt, timezone) : null,
        consoleHref: hasConsole ? consoleProfileLink(l.accountId, l.profileKey) : null,
        tasks: l.followUps.map((f) => ({ id: f.id, label: followUpLabel(f), dueDate: f.dueDate, overdue: Boolean(f.dueDate && f.dueDate < today), owner: f.fo?.name ?? null })),
      }))
      .sort((a, b) => a.accountName.localeCompare(b.accountName)),
  };
}
