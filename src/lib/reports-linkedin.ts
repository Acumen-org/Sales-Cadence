import { prisma } from './db';
import type { LocalDate } from './dates';
import type { AudienceScope } from './subject';
import { inAudience, withPods, type Credit, type Period, type ReplyRow, type Stamp } from './outreach/metrics';

/**
 * Reports' LinkedIn figures, from what the LinkedIn Console reported (src/lib/linkedin/events.ts).
 * Cadence never acts on LinkedIn, so these are a teammate's own clicks there, each counted once:
 *
 *   requests     connection requests sent: the Console's `linkedin:` touches, credited to the teammate
 *                who sent them. A request the Console reports twice (the click, then the Sent list)
 *                counts once; one sent again after a withdrawal is a new request.
 *   accepted     of those requests, the ones accepted so far (our own requests only: an acceptance the
 *                Console says was of their request to us is left out), credited to who sent it
 *   messages     LinkedIn messages sent, each Console touch once
 *   replies      the LinkedIn part of Reports' Replies: the same reply rows (metrics.replyRows), so the
 *                same credit, and never added to Replies a second time
 *   open/overdue LinkedIn tasks Cadence opened (LinkedInFollowUp) still open now, and those past due
 *
 * None of this changes Sent: Sent counts campaign steps done (a LinkedIn step closed by a Console
 * touch is that step), never touches.
 */

export const LINKEDIN_REQUEST_SENT = 'LinkedIn connection request sent';
export const LINKEDIN_MESSAGE_SENT = 'LinkedIn message sent';

export type LinkedInFigures = { requests: number; accepted: number; acceptanceRate: number; messages: number; replies: number; open: number; overdue: number };
export type LinkedInRepRow = LinkedInFigures & { key: string; label: string };
export type LinkedInReport = { totals: LinkedInFigures; byRep: LinkedInRepRow[] };

type SentRow = Credit & { audience: Stamp; kind: 'request' | 'message'; accepted: boolean };
type OpenRow = Credit & { audience: Stamp; dueDate: string | null };
export type LinkedInRows = { sent: SentRow[]; open: OpenRow[] };

type Outcome = { counted: boolean; accepted: boolean };

/**
 * Each request event: whether it is a new request (not a second sighting of one still waiting) and
 * whether it was accepted, read from the Console's history for the same account and profile.
 */
async function requestOutcomes(seqs: bigint[]): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  if (!seqs.length) return out;
  const own = await prisma.linkedInEvent.findMany({ where: { seq: { in: seqs } }, select: { profileKey: true } });
  const keys = [...new Set(own.flatMap((e) => (e.profileKey ? [e.profileKey] : [])))];
  if (!keys.length) return out;
  const history = await prisma.linkedInEvent.findMany({
    where: { profileKey: { in: keys }, type: { in: ['invitation.sent', 'invitation.withdrawn', 'connection.accepted'] } },
    select: { seq: true, type: true, at: true, accountId: true, profileKey: true, payload: true },
    orderBy: [{ at: 'asc' }, { seq: 'asc' }],
  });
  const waiting = new Map<string, Outcome>();
  const connected = new Set<string>();
  for (const e of history) {
    const pair = `${e.accountId ?? 'unknown'}|${e.profileKey}`;
    if (e.type === 'invitation.sent') {
      const fresh = !waiting.has(pair) && !connected.has(pair);
      const o: Outcome = { counted: fresh, accepted: false };
      out.set(e.seq.toString(), o);
      if (fresh) waiting.set(pair, o);
    } else if (e.type === 'invitation.withdrawn') {
      waiting.delete(pair);
    } else {
      const o = waiting.get(pair);
      const ours = (e.payload as { data?: { invitedByUs?: unknown } } | null)?.data?.invitedByUs !== false;
      if (o && ours) o.accepted = true;
      waiting.delete(pair);
      connected.add(pair);
    }
  }
  return out;
}

/** Requests and messages sent in the period, and LinkedIn tasks open now, each with its credit and audience. */
export async function linkedinRows(period: Period): Promise<LinkedInRows> {
  const [touches, followUps] = await Promise.all([
    prisma.touch.findMany({
      where: {
        channel: 'LINKEDIN', direction: 'OUTBOUND', externalId: { startsWith: 'linkedin:' }, copyOfTouchId: null,
        occurredAt: { gte: period.from, lt: period.to },
        OR: [{ summary: { startsWith: LINKEDIN_REQUEST_SENT } }, { summary: { startsWith: LINKEDIN_MESSAGE_SENT } }],
      },
      select: { externalId: true, summary: true, actorUserId: true, audience: true },
    }),
    prisma.linkedInFollowUp.findMany({
      // LinkedIn tasks only: "Reply to their email" lives in the same table.
      where: { state: 'OPEN', kind: { not: 'EMAIL_REPLY' } },
      select: { foUserId: true, dueDate: true, audience: true, personId: true, sandboxContact: { select: { podId: true } } },
    }),
  ]);
  const seqOf = (externalId: string) => { try { return BigInt(externalId.slice('linkedin:'.length)); } catch { return null; } };
  const requests = touches.filter((t) => t.summary.startsWith(LINKEDIN_REQUEST_SENT));
  const outcomes = await requestOutcomes(requests.flatMap((t) => { const s = seqOf(t.externalId); return s === null ? [] : [s]; }));
  const sent: SentRow[] = [];
  for (const t of touches) {
    const base = { rep: t.actorUserId, pod: null, audience: t.audience };
    if (t.summary.startsWith(LINKEDIN_MESSAGE_SENT)) { sent.push({ ...base, kind: 'message', accepted: false }); continue; }
    // A touch whose event is not found still counts as a request, not accepted.
    const o = outcomes.get(seqOf(t.externalId)?.toString() ?? '') ?? { counted: true, accepted: false };
    if (o.counted) sent.push({ ...base, kind: 'request', accepted: o.accepted });
  }
  const open: OpenRow[] = followUps.map((f) => ({
    rep: f.foUserId, pod: f.sandboxContact?.podId ?? null, dueDate: f.dueDate,
    audience: f.audience ?? (f.personId ? 'CRM' : 'SANDBOX'),
  }));
  const [s, o] = await Promise.all([withPods(sent), withPods(open)]);
  return { sent: s, open: o };
}

const empty = (): LinkedInFigures => ({ requests: 0, accepted: 0, acceptanceRate: 0, messages: 0, replies: 0, open: 0, overdue: 0 });

/** The figures for one audience and scope, per rep and in total. `replies` are Reports' reply rows already in scope and audience. */
export function linkedinReport(rows: LinkedInRows, replies: Array<ReplyRow>, opts: { audience: AudienceScope; inScope: (c: Credit) => boolean; today: LocalDate; userName: Map<string, string> }): LinkedInReport {
  const totals = empty();
  const by = new Map<string, LinkedInRepRow>();
  const row = (rep: string | null) => {
    const key = rep ?? 'none';
    let r = by.get(key);
    if (!r) { r = { key, label: rep ? opts.userName.get(rep) ?? 'Unknown' : 'No rep yet', ...empty() }; by.set(key, r); }
    return r;
  };
  const wanted = <T extends Credit & { audience: Stamp }>(list: T[]) => list.filter((x) => opts.inScope(x) && inAudience(x.audience, opts.audience));
  for (const x of wanted(rows.sent)) {
    const r = row(x.rep);
    for (const f of [r, totals]) {
      if (x.kind === 'message') f.messages += 1;
      else { f.requests += 1; if (x.accepted) f.accepted += 1; }
    }
  }
  for (const x of replies) if (x.channel === 'LINKEDIN') { row(x.rep).replies += 1; totals.replies += 1; }
  for (const x of wanted(rows.open)) {
    const late = !!x.dueDate && x.dueDate < opts.today;
    for (const f of [row(x.rep), totals]) { f.open += 1; if (late) f.overdue += 1; }
  }
  const rate = (f: LinkedInFigures) => ({ ...f, acceptanceRate: f.requests ? f.accepted / f.requests : 0 });
  return {
    totals: rate(totals),
    byRep: [...by.values()].map((r) => rate(r) as LinkedInRepRow)
      .sort((a, b) => (a.key === 'none' ? 1 : 0) - (b.key === 'none' ? 1 : 0) || b.requests - a.requests || b.messages - a.messages || a.label.localeCompare(b.label)),
  };
}
