import type { SandboxMoveItem } from '@prisma/client';
import { prisma } from '../db';
import { formatLocalDate, toLocalDate } from '../dates';
import { getSettings } from '../settings';
import { workspaceTimezone } from '../workspace';
import { canUndoMove, type Actor } from '../auth/rbac';
import { coldRef, subjectHref } from '../subject';
import { undoClosesOn, undoLeftWords, type LeftOut, type UndoReport } from './move';

/**
 * What the Move to CRM pages read (4.5): one move's result page, the Moves tab, and a contact's last
 * move for its page and its list row. Everything a person may do is worked out here, on the server,
 * so a button shows only to whoever may use it (B106).
 */

const day = (d: Date) => formatLocalDate(toLocalDate(d, workspaceTimezone()), 'year');

export type MoveTone = 'gray' | 'blue' | 'green' | 'amber' | 'red';
export const ITEM_STATE: Record<string, { label: string; tone: MoveTone }> = {
  QUEUED: { label: 'Waiting', tone: 'gray' }, RUNNING: { label: 'Moving to CRM…', tone: 'blue' }, DONE: { label: 'In the CRM', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' }, DRY_RUN: { label: 'Dry run', tone: 'amber' }, UNDOING: { label: 'Undoing…', tone: 'blue' },
  UNDONE: { label: 'Undone', tone: 'gray' }, UNDO_PARTIAL: { label: 'Undo incomplete', tone: 'amber' },
};

/** B098: the Undo confirm, worded by what the move did. */
export function undoConfirmWords(mode: string, personName: string, contactName: string): string {
  return mode === 'attach'
    ? `${personName} stays in the CRM; only the history moved from here is removed. ${contactName} comes back to Cold outreach.`
    : `Deletes ${personName} from the CRM and brings ${contactName} back to Cold outreach.`;
}

export type MoveRow = {
  itemId: string;
  contactId: string;
  name: string;
  href: string;
  state: string;
  stateLabel: string;
  tone: MoveTone;
  mode: string;
  personId: string | null;
  personName: string | null;
  /** "Created firm Harbor Light", "Linked to firm X", and after an undo "Firm removed" or "Firm kept" (B109). */
  firm: string | null;
  /** A failure in plain words (B100), or what was written ("3 notes written"). */
  detail: string | null;
  failure: string | null;
  /** The button that fixes a failure (B036). */
  fix: { label: string; href: string } | null;
  /** "4 Nov 2027", from the item's own deadline (N062); null once closed or not done. */
  undoUntil: string | null;
  canUndo: boolean;
  /** The campaigns the move ended, which Undo offers back (B101). */
  campaigns: { enrollmentId: string; name: string }[];
  undoConfirm: string;
};

export type MovePage = {
  id: string;
  moverName: string;
  createdAt: Date;
  count: number;
  settled: boolean;
  counts: { done: number; waiting: number; failed: number; undone: number };
  /** Share of items that have finished, for the progress bar. */
  progress: number;
  leftOut: LeftOut[];
  rows: MoveRow[];
  /** Failed items Retry can help with, when this viewer may retry (B036, B188). */
  retryable: number;
  /** Items Undo all would undo (B187): done, in their window, this viewer may undo. */
  undoAll: string[];
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function firmWords(i: SandboxMoveItem, companyName: string | null): string | null {
  if (i.mode === 'attach') return null;
  const report = i.undoReport as UndoReport | null;
  if (i.state === 'UNDONE' || i.state === 'UNDO_PARTIAL') {
    if (i.companyAction !== 'created') return null;
    return report?.companyDeleted ? `Firm ${companyName ?? ''} removed`.replace('  ', ' ') : `Firm ${companyName ?? ''} kept: others are at it`.replace('  ', ' ');
  }
  if (i.companyAction === 'created') return `Created firm ${companyName ?? ''}`.trim();
  if (i.companyAction === 'linked') return `Linked to firm ${companyName ?? ''}`.trim();
  return null;
}

/** One move, as its result page shows it to this viewer. */
export async function loadMovePage(moveId: string, viewer: Actor, now = new Date()): Promise<MovePage | null> {
  const move = await prisma.sandboxMove.findUnique({ where: { id: moveId }, include: { items: true } });
  if (!move) return null;
  const settings = await getSettings();
  const contactIds = move.items.map((i) => i.sandboxContactId);
  const personIds = move.items.flatMap((i) => (i.twentyPersonId ? [i.twentyPersonId] : []));
  const companyIds = move.items.flatMap((i) => (i.twentyCompanyId ? [i.twentyCompanyId] : []));
  const enrollmentIds = move.items.flatMap((i) => i.exitedEnrollmentIds);
  const [contacts, people, companies, mover, enrollments] = await Promise.all([
    prisma.sandboxContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, firstName: true, lastName: true, status: true, podId: true, movedById: true } }),
    prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, firstName: true, lastName: true } }),
    prisma.companyCache.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }),
    prisma.user.findUnique({ where: { id: move.createdById }, select: { name: true } }),
    prisma.enrollment.findMany({ where: { id: { in: enrollmentIds } }, select: { id: true, campaign: { select: { name: true, status: true } }, sequence: { select: { name: true } } } }),
  ]);
  const snapshotName = (s: unknown) => { const v = s as { firstName?: string; lastName?: string } | null; return `${v?.firstName ?? ''} ${v?.lastName ?? ''}`.trim(); };
  const rows: MoveRow[] = move.items.map((i) => {
    const c = contacts.find((x) => x.id === i.sandboxContactId);
    const name = (c ? `${c.firstName} ${c.lastName}`.trim() : '') || snapshotName(i.snapshot) || 'Contact';
    const p = people.find((x) => x.id === i.twentyPersonId);
    const personName = p ? `${p.firstName} ${p.lastName}`.trim() : null;
    const closes = undoClosesOn(i, settings.sandbox);
    const open = i.state === 'DONE' && Boolean(closes && closes > now) && c?.status === 'MOVED';
    const may = canUndoMove(viewer, { movedById: c?.movedById ?? move.createdById, podId: c?.podId ?? null });
    const report = i.undoReport as UndoReport | null;
    const left = report ? undoLeftWords(report, personName ?? 'the CRM person') : null;
    const contactHref = subjectHref(coldRef(i.sandboxContactId));
    const detail = i.state === 'FAILED' || i.state === 'DRY_RUN' ? i.error
      : i.state === 'UNDO_PARTIAL' ? `Undo incomplete: ${left ?? 'part of it is still in the CRM'}`
      : i.state === 'DONE' && i.notesWritten.length ? `${plural(i.notesWritten.length, 'note')} written to the CRM` : null;
    const fix = i.state === 'FAILED' && i.failure === 'permanent' && c?.status === 'ACTIVE'
      ? { label: /owner/i.test(i.error ?? '') ? 'Assign a new owner' : /form/i.test(i.error ?? '') ? 'Fill in the form' : 'Move again', href: contactHref }
      : null;
    return {
      itemId: i.id, contactId: i.sandboxContactId, name, href: i.state === 'DONE' && i.twentyPersonId ? `/people/${i.twentyPersonId}` : contactHref,
      state: i.state, stateLabel: ITEM_STATE[i.state]?.label ?? i.state, tone: ITEM_STATE[i.state]?.tone ?? 'gray', mode: i.mode,
      personId: i.twentyPersonId, personName, firm: firmWords(i, companies.find((x) => x.id === i.twentyCompanyId)?.name ?? null), detail, failure: i.failure, fix,
      undoUntil: open && closes ? day(closes) : null, canUndo: (open || i.state === 'UNDO_PARTIAL') && may,
      campaigns: i.exitedEnrollmentIds.flatMap((id) => { const e = enrollments.find((x) => x.id === id); return e && (!e.campaign || e.campaign.status === 'ACTIVE') ? [{ enrollmentId: id, name: e.campaign?.name ?? e.sequence.name }] : []; }),
      undoConfirm: undoConfirmWords(i.mode, personName ?? 'the CRM person', name),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const counts = {
    done: move.items.filter((i) => i.state === 'DONE').length,
    waiting: move.items.filter((i) => i.state === 'QUEUED' || i.state === 'RUNNING' || i.state === 'UNDOING').length,
    failed: move.items.filter((i) => i.state === 'FAILED').length,
    undone: move.items.filter((i) => i.state === 'UNDONE' || i.state === 'UNDO_PARTIAL').length,
  };
  const mayRetry = (i: SandboxMoveItem) => canUndoMove(viewer, { movedById: move.createdById, podId: contacts.find((c) => c.id === i.sandboxContactId)?.podId ?? null });
  return {
    id: move.id, moverName: mover?.name ?? 'Someone', createdAt: move.createdAt, count: move.items.length, settled: !counts.waiting,
    counts, progress: move.items.length ? Math.round(((move.items.length - counts.waiting) / move.items.length) * 100) : 100,
    leftOut: Array.isArray(move.leftOut) ? (move.leftOut as unknown as LeftOut[]) : [],
    rows,
    retryable: move.items.filter((i) => i.state === 'FAILED' && i.failure !== 'permanent' && mayRetry(i)).length,
    undoAll: rows.filter((r) => r.state === 'DONE' && r.canUndo).map((r) => r.itemId),
  };
}

export type MoveListRow = { id: string; createdAt: Date; moverId: string; moverName: string; count: number; done: number; failed: number; waiting: number; undone: number; names: string[] };

/** The Moves tab (4.5): every move, failed ones stay visible, newest first; by state and by mover. */
export async function listMoves(filters: { state?: string | null; moverId?: string | null; podId?: string | null }, take = 100): Promise<MoveListRow[]> {
  // A pod's moves: those of contacts in that pod (owner, 10 Nov 2026: Cold outreach opens on the reader's pod).
  const inPod = filters.podId ? (await prisma.sandboxContact.findMany({ where: { podId: filters.podId }, select: { id: true } })).map((c) => c.id) : null;
  const where = {
    ...(filters.moverId ? { createdById: filters.moverId } : {}),
    ...(filters.state === 'running' ? { state: { in: ['QUEUED', 'RUNNING'] } } : {}),
    AND: [
      ...(inPod ? [{ items: { some: { sandboxContactId: { in: inPod } } } }] : []),
      ...(filters.state === 'failed' ? [{ items: { some: { state: 'FAILED' } } }] : filters.state === 'undone' ? [{ items: { some: { state: { in: ['UNDONE', 'UNDO_PARTIAL'] } } } }] : []),
    ],
  };
  const moves = await prisma.sandboxMove.findMany({ where, orderBy: { createdAt: 'desc' }, take, include: { items: { select: { state: true, sandboxContactId: true, snapshot: true } } } });
  const movers = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return moves.map((m) => ({
    id: m.id, createdAt: m.createdAt, moverId: m.createdById, moverName: movers.get(m.createdById) ?? 'Someone', count: m.items.length,
    done: m.items.filter((i) => i.state === 'DONE').length, failed: m.items.filter((i) => i.state === 'FAILED').length,
    waiting: m.items.filter((i) => i.state === 'QUEUED' || i.state === 'RUNNING').length, undone: m.items.filter((i) => i.state === 'UNDONE' || i.state === 'UNDO_PARTIAL').length,
    names: m.items.slice(0, 3).map((i) => { const s = i.snapshot as { firstName?: string; lastName?: string } | null; return `${s?.firstName ?? ''} ${s?.lastName ?? ''}`.trim(); }).filter(Boolean),
  }));
}

/** A contact's latest move item, as its page and its list row show it: the move, a failure, Undo (B036, B108). */
export type ContactMove = {
  itemId: string; moveId: string; state: string; mode: string; error: string | null; failure: string | null;
  moverName: string | null; doneAt: Date | null; undoUntil: string | null; canUndo: boolean; personId: string | null; personName: string | null;
  undoConfirm: string; campaigns: { enrollmentId: string; name: string }[];
};

export async function latestMoves(contactIds: string[], viewer: Actor, now = new Date()): Promise<Map<string, ContactMove>> {
  const out = new Map<string, ContactMove>();
  if (!contactIds.length) return out;
  const settings = await getSettings();
  const items = await prisma.sandboxMoveItem.findMany({ where: { sandboxContactId: { in: contactIds } }, include: { move: { select: { id: true, createdAt: true, createdById: true } } }, orderBy: { move: { createdAt: 'desc' } } });
  const latest = new Map<string, (typeof items)[number]>();
  for (const i of items) if (!latest.has(i.sandboxContactId)) latest.set(i.sandboxContactId, i);
  const [contacts, people, movers, enrollments] = await Promise.all([
    prisma.sandboxContact.findMany({ where: { id: { in: [...latest.keys()] } }, select: { id: true, firstName: true, lastName: true, status: true, podId: true, movedById: true } }),
    prisma.personCache.findMany({ where: { id: { in: [...latest.values()].flatMap((i) => (i.twentyPersonId ? [i.twentyPersonId] : [])) } }, select: { id: true, firstName: true, lastName: true } }),
    prisma.user.findMany({ where: { id: { in: [...latest.values()].map((i) => i.move.createdById) } }, select: { id: true, name: true } }),
    prisma.enrollment.findMany({ where: { id: { in: [...latest.values()].flatMap((i) => i.exitedEnrollmentIds) } }, select: { id: true, campaign: { select: { name: true, status: true } }, sequence: { select: { name: true } } } }),
  ]);
  for (const [contactId, i] of latest) {
    const c = contacts.find((x) => x.id === contactId);
    const p = people.find((x) => x.id === i.twentyPersonId);
    const personName = p ? `${p.firstName} ${p.lastName}`.trim() : null;
    const closes = undoClosesOn(i, settings.sandbox);
    const open = i.state === 'DONE' && Boolean(closes && closes > now) && c?.status === 'MOVED';
    out.set(contactId, {
      itemId: i.id, moveId: i.moveId, state: i.state, mode: i.mode, error: i.error, failure: i.failure,
      moverName: movers.find((u) => u.id === i.move.createdById)?.name ?? null, doneAt: i.doneAt, undoUntil: open && closes ? day(closes) : null,
      canUndo: open && canUndoMove(viewer, { movedById: c?.movedById ?? i.move.createdById, podId: c?.podId ?? null }), personId: i.twentyPersonId, personName,
      undoConfirm: undoConfirmWords(i.mode, personName ?? 'the CRM person', c ? `${c.firstName} ${c.lastName}`.trim() : 'the contact'),
      campaigns: i.exitedEnrollmentIds.flatMap((id) => { const e = enrollments.find((x) => x.id === id); return e && (!e.campaign || e.campaign.status === 'ACTIVE') ? [{ enrollmentId: id, name: e.campaign?.name ?? e.sequence.name }] : []; }),
    });
  }
  return out;
}
