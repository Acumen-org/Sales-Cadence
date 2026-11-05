import type { CallSource, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getSettings } from '../settings';
import { callOutcomes } from '../engine/outcomes';
import { workspaceTimezone } from '../workspace';
import { SANDBOX_SUBJECT, SANDBOX_TASK, CRM_SUBJECT, CRM_TASK } from '../subject';

/**
 * Reports > Calls (plan section 11) and the sandbox and platform numbers of Reports (decision 2):
 * sandbox numbers on their own, and combined with the rest of the platform. Every figure here is
 * defined once, in this file.
 */

export type CallFilters = { from: Date; to: Date; podId?: string | null; foUserId?: string | null; campaignId?: string | null; direction?: 'OUTBOUND' | 'INBOUND' | null; source?: CallSource | null };
export type Audience = 'crm' | 'sandbox' | 'platform';

export type CallTotals = { dials: number; inbound: number; connects: number; connectRate: number; conversations: number; talkSec: number; avgTalkPerConnect: number; meetings: number; avgRating: number | null; formsOutstanding: number; medianMinutesToForm: number | null; costUsd: number };

/**
 * N046: forms waiting now, whatever the period, by whoever holds them (the rep, or whom it was handed
 * to), with the oldest one's due time: the backlog leaders chase. Scoped by pod or rep only.
 */
export async function formsWaiting(f: { podId?: string | null; foUserId?: string | null } = {}): Promise<Map<string, { count: number; oldest: Date }>> {
  const podUsers = f.podId ? (await prisma.userPod.findMany({ where: { podId: f.podId }, select: { userId: true } })).map((u) => u.userId) : null;
  const rows = await prisma.callLog.findMany({ where: { formDueAt: { not: null }, formDoneAt: null, discardedAt: null }, select: { userId: true, formUserId: true, formDueAt: true } });
  const by = new Map<string, { count: number; oldest: Date }>();
  for (const r of rows) {
    const holder = r.formUserId ?? r.userId;
    if (!holder || (f.foUserId && holder !== f.foUserId) || (podUsers && !podUsers.includes(holder))) continue;
    const cur = by.get(holder);
    if (!cur) by.set(holder, { count: 1, oldest: r.formDueAt! });
    else { cur.count++; if (r.formDueAt! < cur.oldest) cur.oldest = r.formDueAt!; }
  }
  return by;
}

type CallRow = Prisma.CallLogGetPayload<{ include: { form: true; user: { select: { id: true; name: true } } } }>;

async function callsIn(f: CallFilters): Promise<CallRow[]> {
  const podUsers = f.podId ? (await prisma.userPod.findMany({ where: { podId: f.podId }, select: { userId: true } })).map((u) => u.userId) : null;
  return prisma.callLog.findMany({
    where: {
      startedAt: { gte: f.from, lt: f.to },
      // A call discarded as a mistake counts nowhere (B024).
      discardedAt: null,
      ...(f.foUserId ? { userId: f.foUserId } : podUsers ? { userId: { in: podUsers } } : {}),
      ...(f.campaignId ? { campaignId: f.campaignId } : {}),
      ...(f.direction ? { direction: f.direction } : {}),
      ...(f.source ? { source: f.source } : {}),
    },
    include: { form: true, user: { select: { id: true, name: true } } },
    orderBy: { startedAt: 'desc' },
    take: 20_000,
  });
}

const audienceOf = (c: Pick<CallRow, 'personId' | 'sandboxContactId'>): 'crm' | 'sandbox' | null => (c.personId ? 'crm' : c.sandboxContactId ? 'sandbox' : null);

function totals(calls: CallRow[], answered: Set<string>, connectSeconds: number, conversationSeconds: number): CallTotals {
  const outbound = calls.filter((c) => c.direction === 'OUTBOUND');
  const isConnect = (c: CallRow) => (c.form ? answered.has(c.form.outcome) : c.status === 'COMPLETED' && (c.talkSec ?? 0) >= connectSeconds);
  const connects = calls.filter(isConnect);
  const talk = connects.reduce((n, c) => n + (c.talkSec ?? 0), 0);
  const rated = calls.filter((c) => c.form?.rating);
  const waits = calls.filter((c) => c.formDoneAt && c.formDueAt).map((c) => (c.formDoneAt!.getTime() - c.formDueAt!.getTime()) / 60_000).sort((a, b) => a - b);
  return {
    dials: outbound.length,
    inbound: calls.length - outbound.length,
    connects: connects.length,
    connectRate: outbound.length ? connects.filter((c) => c.direction === 'OUTBOUND').length / outbound.length : 0,
    conversations: connects.filter((c) => (c.talkSec ?? 0) >= conversationSeconds).length,
    talkSec: talk,
    avgTalkPerConnect: connects.length ? Math.round(talk / connects.length) : 0,
    meetings: calls.filter((c) => c.form?.outcome === 'meeting_booked').length,
    avgRating: rated.length ? Math.round((rated.reduce((n, c) => n + (c.form!.rating ?? 0), 0) / rated.length) * 10) / 10 : null,
    formsOutstanding: calls.filter((c) => c.formDueAt && !c.formDoneAt).length,
    medianMinutesToForm: waits.length ? Math.round(waits[Math.floor(waits.length / 2)]) : null,
    costUsd: Math.round(calls.reduce((n, c) => n + Number(c.priceUsd ?? 0), 0) * 100) / 100,
  };
}

export async function callReport(f: CallFilters) {
  const settings = await getSettings();
  const outcomes = callOutcomes(settings.rules);
  const answered = new Set(outcomes.filter((o) => o.answered).map((o) => o.key));
  const span = f.to.getTime() - f.from.getTime();
  const [calls, previousCalls, users, waiting] = await Promise.all([callsIn(f), callsIn({ ...f, from: new Date(f.from.getTime() - span), to: f.from }), prisma.user.findMany({ select: { id: true, name: true } }), formsWaiting(f)]);
  const t = (list: CallRow[]) => totals(list, answered, settings.calling.connectSeconds, settings.calling.conversationSeconds);
  const split: Record<Audience, CallTotals> = { crm: t(calls.filter((c) => audienceOf(c) === 'crm')), sandbox: t(calls.filter((c) => audienceOf(c) === 'sandbox')), platform: t(calls) };
  // N046: forms outstanding are the backlog now, never only the period's.
  split.platform.formsOutstanding = [...waiting.values()].reduce((n, w) => n + w.count, 0);
  const repIds = new Set([...calls.map((c) => c.userId).filter((id): id is string => Boolean(id)), ...waiting.keys()]);
  const byRep = [...repIds].map((id) => ({ userId: id, name: users.find((u) => u.id === id)?.name ?? 'Unknown', ...t(calls.filter((c) => c.userId === id)), formsOutstanding: waiting.get(id)?.count ?? 0, oldestFormDue: waiting.get(id)?.oldest ?? null })).sort((a, b) => b.dials - a.dials || b.formsOutstanding - a.formsOutstanding);
  const byOutcome = outcomes.map((o) => ({ key: o.key, label: o.label, count: calls.filter((c) => c.form?.outcome === o.key).length })).filter((o) => o.count);
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: workspaceTimezone(), hour: 'numeric', weekday: 'short', hour12: false });
  const hours = new Map<string, { dials: number; connects: number }>();
  for (const c of calls) {
    if (c.direction !== 'OUTBOUND' || !c.startedAt) continue;
    const parts = hourFmt.formatToParts(c.startedAt);
    const key = `${parts.find((p) => p.type === 'weekday')?.value} ${Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24}`;
    const cell = hours.get(key) ?? { dials: 0, connects: 0 };
    cell.dials++;
    if (c.form ? answered.has(c.form.outcome) : c.status === 'COMPLETED' && (c.talkSec ?? 0) >= settings.calling.connectSeconds) cell.connects++;
    hours.set(key, cell);
  }
  const bestHours = [...hours.entries()].map(([slot, v]) => ({ slot, ...v, rate: v.dials ? v.connects / v.dials : 0 })).filter((h) => h.dials >= 3).sort((a, b) => b.rate - a.rate).slice(0, 6);
  const unmatched = await prisma.callLog.findMany({ where: { startedAt: { gte: f.from, lt: f.to }, OR: [{ userId: null }, { matchedBy: { in: ['none', 'ambiguous'] } }] }, orderBy: { startedAt: 'desc' }, take: 100 });
  return { totals: split.platform, previous: t(previousCalls), split, byRep, byOutcome, bestHours, calls: calls.slice(0, 100), unmatched, outcomes };
}

/** The sandbox on its own (Reports > Sandbox) and the figures both sides share, added up (Platform). */
export async function sandboxReport(f: { from: Date; to: Date; podId?: string | null; foUserId?: string | null }) {
  const range = { gte: f.from, lt: f.to };
  const owner = { ...(f.foUserId ? { ownerId: f.foUserId } : {}), ...(f.podId ? { podId: f.podId } : {}) };
  const fo = { ...(f.foUserId ? { foUserId: f.foUserId } : {}), ...(f.podId ? { enrollment: { podId: f.podId } } : {}) };
  const settings = await getSettings();
  const answered = new Set(callOutcomes(settings.rules).filter((o) => o.answered).map((o) => o.key));
  const [added, pushed, claimed, moved, optedOut, sandboxCalls, crmCalls, sandboxSteps, crmSteps, sandboxNext, crmNext] = await Promise.all([
    prisma.sandboxContact.count({ where: { createdAt: range, ...owner } }),
    prisma.sandboxContact.count({ where: { createdAt: range, source: 'BELLWETHER', ...owner } }),
    prisma.sandboxContact.count({ where: { claimedAt: range, ...owner } }),
    prisma.sandboxContact.count({ where: { movedAt: range, ...owner } }),
    prisma.sandboxContact.count({ where: { optedOutAt: range, ...owner } }),
    prisma.callLog.findMany({ where: { startedAt: range, sandboxContactId: { not: null }, personId: null, ...(f.foUserId ? { userId: f.foUserId } : {}) }, select: { sandboxContactId: true, status: true, talkSec: true, form: { select: { outcome: true } } } }),
    prisma.callLog.findMany({ where: { startedAt: range, personId: { not: null }, ...(f.foUserId ? { userId: f.foUserId } : {}) }, select: { status: true, talkSec: true, form: { select: { outcome: true } } } }),
    prisma.task.count({ where: { AND: [SANDBOX_TASK, fo, { state: 'DONE', completedAt: range }] } }),
    prisma.task.count({ where: { AND: [CRM_TASK, fo, { state: 'DONE', completedAt: range }] } }),
    prisma.nextAction.count({ where: { ...SANDBOX_SUBJECT, lastDoneAt: range, ...(f.foUserId ? { foUserId: f.foUserId } : {}) } }),
    prisma.nextAction.count({ where: { ...CRM_SUBJECT, lastDoneAt: range, ...(f.foUserId ? { foUserId: f.foUserId } : {}) } }),
  ]);
  const connect = (c: { status: string; talkSec: number | null; form: { outcome: string } | null }) => (c.form ? answered.has(c.form.outcome) : c.status === 'COMPLETED' && (c.talkSec ?? 0) >= settings.calling.connectSeconds);
  const meeting = (c: { form: { outcome: string } | null }) => c.form?.outcome === 'meeting_booked';
  const sandbox = {
    added, pushed, claimed, moved, optedOut,
    called: new Set(sandboxCalls.map((c) => c.sandboxContactId)).size,
    connected: new Set(sandboxCalls.filter(connect).map((c) => c.sandboxContactId)).size,
    meetings: sandboxCalls.filter(meeting).length,
    stepsDone: sandboxSteps,
    nextActionsDone: sandboxNext,
    calls: sandboxCalls.length,
  };
  const row = (crm: number, sbx: number) => ({ crm, sandbox: sbx, platform: crm + sbx });
  const platform = {
    stepsDone: row(crmSteps, sandboxSteps),
    calls: row(crmCalls.length, sandboxCalls.length),
    connects: row(crmCalls.filter(connect).length, sandboxCalls.filter(connect).length),
    meetings: row(crmCalls.filter(meeting).length, sandboxCalls.filter(meeting).length),
    nextActionsDone: row(crmNext, sandboxNext),
  };
  return { sandbox, platform };
}
