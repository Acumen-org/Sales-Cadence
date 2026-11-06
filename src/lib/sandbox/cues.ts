import type { SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { getSettings } from '../settings';
import { formatLocalDate, toLocalDate, todayIn, type LocalDate } from '../dates';
import { workspaceTimezone } from '../workspace';
import { ACTION_LABELS, parseSteps } from '../sequences/steps';
import { shortDay } from '../task-cues';
import { contactState, coldRef, subjectHref, personRef, type ContactState } from '../subject';
import { suppressionHash } from './suppression';
import { personalPhone, readExtraPhones } from './normalize';
import { checkReady, moveSignals, type Readiness } from './ready';

/*
 * The cues every Cold outreach screen shows the same way (PLAN 4.0): one status badge per contact and
 * the warning chips beside it, from one function. The contacts list, the contact header, Tasks rows,
 * Ctrl K, the Move dialog and the step strip all read `coldCues`, and `SubjectBadges` draws them.
 */

export type CueTone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'sky';
export type Cue = { label: string; tone: CueTone; title?: string; href?: string };

/** What comes next for a contact: the earlier of its own next step and its campaign's next step (N083). */
export type NextCue = { label: string; due: LocalDate; overdue: boolean; source: 'next_step' | 'campaign' };

export type ColdCue = {
  id: string;
  state: ContactState;
  /** The one status badge (the table in PLAN 4.0). */
  badge: Cue;
  /** Warning chips, in a fixed order: Email bounced, Possible bounce, Wrong number, Email risky, Shared line, Possibly in CRM, Possible duplicate, Form due. */
  chips: Cue[];
  next: NextCue | null;
  /** Complete CRM details, whatever the outcome: the hard rule for a move (D3). */
  readiness: Readiness;
  /** The positive outcome that makes complete details "Ready to move", in words. */
  positive: string | null;
  /** A call to this contact is waiting for its form. */
  formDue: boolean;
  /** Ever called, or in a campaign: the rep has started on it (the step strip's step 2). */
  worked: boolean;
};

const DATE_TZ = () => workspaceTimezone();
const dayWithYear = (at: Date) => formatLocalDate(toLocalDate(at, DATE_TZ()), 'year');
const nameOf = (p: { firstName: string; lastName: string } | null | undefined) => (p ? `${p.firstName} ${p.lastName}`.trim() : '');

type CueContact = Pick<SandboxContact, 'id' | 'status' | 'firstName' | 'lastName' | 'companyName' | 'email' | 'emailVerification' | 'badEmail' | 'phone' | 'phoneType' | 'badPhone' | 'additionalPhones' | 'jobTitle' | 'linkedinUrl' | 'city' | 'productInterest' | 'ownerId' | 'podId' | 'optedOutAt' | 'movedAt' | 'twentyPersonId' | 'crmMatchPersonId' | 'crmAutoPersonId' | 'possibleCrmPersonId' | 'possibleDuplicateId' | 'possibleBounceAt' | 'lastOutcome'>;

/**
 * Cues for many contacts at once: a fixed handful of queries whatever the number of ids. `today` is
 * the reader's day, for "overdue".
 */
export async function coldCues(ids: string[], opts: { today?: LocalDate } = {}): Promise<Map<string, ColdCue>> {
  const out = new Map<string, ColdCue>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const today = opts.today ?? todayIn(DATE_TZ());
  const [settings, contacts, moving, running, nexts, forms, calls, signals, scheduled] = await Promise.all([
    getSettings(),
    prisma.sandboxContact.findMany({ where: { id: { in: unique } }, include: { owner: { select: { name: true, twentyMemberId: true, active: true } }, pod: { select: { name: true } } } }),
    prisma.sandboxMoveItem.findMany({ where: { sandboxContactId: { in: unique }, state: { in: ['QUEUED', 'RUNNING'] } }, select: { sandboxContactId: true } }),
    prisma.enrollment.findMany({ where: { sandboxContactId: { in: unique }, personId: null, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { sandboxContactId: true, status: true, currentStep: true, startDate: true, campaign: { select: { name: true } }, sequence: { select: { name: true, steps: true } }, tasks: { where: { state: 'PENDING' }, orderBy: [{ dueDate: 'asc' }, { stepIndex: 'asc' }], take: 1, select: { action: true, dueDate: true, snoozedTo: true, stepIndex: true } } } }),
    prisma.nextAction.findMany({ where: { sandboxContactId: { in: unique }, personId: null, state: 'OPEN' }, select: { sandboxContactId: true, label: true, action: true, kind: true, dueDate: true } }),
    prisma.callLog.findMany({ where: { sandboxContactId: { in: unique }, formDueAt: { not: null }, formDoneAt: null, discardedAt: null }, select: { sandboxContactId: true } }),
    prisma.callLog.findMany({ where: { sandboxContactId: { in: unique } }, select: { sandboxContactId: true }, distinct: ['sandboxContactId'] }),
    moveSignals(unique),
    // B144, B163: a scheduled campaign holds its contacts before it starts; they are in a campaign, not without a next step.
    prisma.campaign.findMany({ where: { audience: 'SANDBOX', status: 'SCHEDULED', personIds: { hasSome: unique } }, orderBy: [{ startDate: 'asc' }, { id: 'asc' }], select: { name: true, startDate: true, personIds: true } }),
  ]);
  const movingIds = new Set(moving.map((m) => m.sandboxContactId));
  const formDue = new Set(forms.map((f) => f.sandboxContactId));
  const called = new Set(calls.map((c) => c.sandboxContactId));
  // Names for "Already in CRM: Jane Doe", "Possibly in CRM: Jane Doe" and "Possibly the same as Jane Doe".
  const personIds = [...new Set(contacts.flatMap((c) => [c.crmMatchPersonId, c.crmAutoPersonId, c.possibleCrmPersonId].filter((x): x is string => Boolean(x))))];
  const twinIds = [...new Set(contacts.flatMap((c) => (c.possibleDuplicateId ? [c.possibleDuplicateId] : [])))];
  const [people, twins, shared] = await Promise.all([
    personIds.length ? prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
    twinIds.length ? prisma.sandboxContact.findMany({ where: { id: { in: twinIds } }, select: { id: true, firstName: true, lastName: true, status: true } }) : [],
    sharedLines(contacts),
  ]);
  const personName = new Map(people.map((p) => [p.id, nameOf(p)]));
  for (const c of contacts) {
    const signal = signals.get(c.id) ?? { positive: null, closed: null };
    const readiness = checkReady(c, { owner: c.owner, podName: c.pod?.name ?? null, settings: settings.sandbox });
    const enrollment = running.find((e) => e.sandboxContactId === c.id) ?? null;
    const own = nexts.find((n) => n.sandboxContactId === c.id) ?? null;
    const held = enrollment ? null : scheduled.find((k) => k.personIds.includes(c.id)) ?? null;
    const state = contactState({
      status: c.status, optedOutAt: c.optedOutAt, ownerId: c.ownerId, ownerActive: c.owner?.active ?? true, moving: movingIds.has(c.id),
      crmMatchPersonId: c.crmMatchPersonId, crmAutoPersonId: c.crmAutoPersonId, inCampaign: Boolean(enrollment || held), hasNextStep: Boolean(own),
      lastOutcome: signal.closed ? 'not_interested' : null, detailsComplete: readiness.ready, positiveOutcome: Boolean(signal.positive),
    });
    // N083: the earlier of the contact's own next step and its campaign's next step, labelled.
    const step = enrollment?.tasks[0] ?? null;
    const candidates: NextCue[] = [];
    if (own) candidates.push({ label: own.kind === 'MEETING' ? 'Meeting' : ACTION_LABELS[own.action], due: own.dueDate, overdue: own.dueDate < today, source: 'next_step' });
    if (step) { const due = step.snoozedTo ?? step.dueDate; candidates.push({ label: `${ACTION_LABELS[step.action]} · ${enrollment!.campaign?.name ?? enrollment!.sequence.name}`, due, overdue: due < today, source: 'campaign' }); }
    else if (held) candidates.push({ label: `Campaign starts · ${held.name}`, due: held.startDate, overdue: false, source: 'campaign' });
    // N083: a running campaign whose first touch for this contact is on a later day has no step yet.
    else if (enrollment?.status === 'ACTIVE' && enrollment.startDate && enrollment.startDate > today) candidates.push({ label: `Campaign starts · ${enrollment.campaign?.name ?? enrollment.sequence.name}`, due: enrollment.startDate, overdue: false, source: 'campaign' });
    const next = candidates.sort((a, b) => a.due.localeCompare(b.due))[0] ?? null;
    const crmName = personName.get(c.crmMatchPersonId ?? c.crmAutoPersonId ?? '') || null;
    const badge = badgeFor(state, { contact: c, signal, enrollment, held, own, today, crmName });
    const chips: Cue[] = [];
    const live = c.status === 'ACTIVE';
    if (live && c.badEmail) chips.push({ label: 'Email bounced', tone: 'amber', title: 'Mail to this address came back. Find a new one before emailing.' });
    else if (live && c.possibleBounceAt) chips.push({ label: 'Possible bounce', tone: 'amber', title: `A notice on ${dayWithYear(c.possibleBounceAt)} may be a bounce. Check the address.` });
    if (live && c.badPhone) chips.push({ label: 'Wrong number', tone: 'amber', title: 'A call found this number wrong.' });
    if (live && !c.badEmail && c.email && c.emailVerification === 'risky') chips.push({ label: 'Email risky', tone: 'amber', title: 'Bellwether could only verify this address as risky.' });
    if (live && shared.has(c.id)) chips.push({ label: 'Shared line', tone: 'amber', title: 'A colleague on this office line asked not to be contacted. Call only to reach this person.' });
    if (live && c.possibleCrmPersonId && !c.crmMatchPersonId && !c.crmAutoPersonId) chips.push({ label: `Possibly in CRM${personName.get(c.possibleCrmPersonId) ? `: ${personName.get(c.possibleCrmPersonId)}` : ''}`, tone: 'sky', title: 'Bellwether found someone like this in the CRM. Check before you move.', href: subjectHref(personRef(c.possibleCrmPersonId)) });
    const twin = c.possibleDuplicateId ? twins.find((t) => t.id === c.possibleDuplicateId) : null;
    if (live && twin) chips.push({ label: `Possibly the same as ${nameOf(twin) || 'another contact'}`, tone: 'amber', title: 'Same firm and last name, or the same office line, as another contact here.', href: subjectHref(coldRef(twin.id)) });
    if (formDue.has(c.id)) chips.push({ label: 'Form due', tone: 'amber', title: 'A call to this contact is waiting for its post-call form.' });
    out.set(c.id, { id: c.id, state, badge, chips, next, readiness, positive: signal.positive, formDue: formDue.has(c.id), worked: called.has(c.id) || Boolean(enrollment) });
  }
  return out;
}

type BadgeContext = {
  contact: CueContact & { owner: { name: string; active: boolean } | null };
  signal: { positive: string | null; closed: { outcome: string; at: Date | null } | null };
  enrollment: { status: string; currentStep: number; campaign: { name: string } | null; sequence: { name: string; steps: unknown }; tasks: { stepIndex: number }[] } | null;
  /** A scheduled campaign that holds the contact before it starts. */
  held?: { name: string; startDate: LocalDate } | null;
  own: { label: string; action: keyof typeof ACTION_LABELS; kind: string; dueDate: LocalDate } | null;
  today: LocalDate;
  crmName: string | null;
};

/** The badge for each state, in the words and tones of PLAN 4.0. */
export function badgeFor(state: ContactState, x: BadgeContext): Cue {
  const c = x.contact;
  switch (state) {
    case 'do_not_contact': {
      const at = c.optedOutAt ?? null;
      return { label: `Do not contact${at ? ` · ${dayWithYear(at)}` : ''}`, tone: 'red', title: 'Do not email, call or message this person. Cadence blocks calls and campaigns.' };
    }
    case 'removed': return { label: 'Removed', tone: 'gray' };
    case 'moved': return { label: 'In CRM · Open', tone: 'green', href: c.twentyPersonId ? subjectHref(personRef(c.twentyPersonId)) : undefined, title: c.movedAt ? `Moved to the CRM on ${dayWithYear(c.movedAt)}` : undefined };
    case 'moving': return { label: 'Moving to CRM…', tone: 'blue' };
    case 'already_in_crm': return { label: `Already in CRM${x.crmName ? `: ${x.crmName}` : ''}`, tone: 'sky', title: 'Outreach stopped. Move to CRM adds this history to them.', href: subjectHref(personRef((c.crmMatchPersonId ?? c.crmAutoPersonId)!)) };
    case 'unclaimed': return { label: c.ownerId && c.owner && !c.owner.active ? `Unclaimed: ${c.owner.name} left` : 'Unclaimed', tone: 'amber' };
    case 'ready_to_move': return { label: 'Ready to move', tone: 'green', title: x.signal.positive ? `Complete CRM details and a positive outcome: ${x.signal.positive}` : undefined };
    case 'in_campaign': {
      if (!x.enrollment && x.held) return { label: `${x.held.name} · starts ${shortDay(x.held.startDate)}`, tone: 'blue', title: 'A scheduled campaign holds this contact. Its first step comes when it starts.' };
      const e = x.enrollment!;
      const steps = parseStepsSafe(e.sequence.steps);
      const at = e.tasks[0]?.stepIndex ?? Math.max(0, e.currentStep);
      return { label: `${e.campaign?.name ?? e.sequence.name}${steps ? ` · step ${Math.min(at + 1, steps)} of ${steps}` : ''}${e.status === 'PAUSED' ? ' · paused' : ''}`, tone: 'blue' };
    }
    case 'next_step_set': {
      const n = x.own!;
      const overdue = n.dueDate < x.today;
      return { label: `${n.kind === 'MEETING' ? 'Meeting' : ACTION_LABELS[n.action]} · ${shortDay(n.dueDate)}`, tone: overdue ? 'red' : 'blue', title: overdue ? `Overdue: ${n.label}` : n.label };
    }
    case 'closed': {
      const cl = x.signal.closed;
      return { label: `Closed${cl ? ` · ${cl.outcome}${cl.at ? ` · ${formatLocalDate(toLocalDate(cl.at, DATE_TZ()))}` : ''}` : ''}`, tone: 'gray', title: 'Set a new next step to reopen it, or opt it out.' };
    }
    case 'no_next_step': return { label: 'No next step', tone: 'amber', title: 'Set a next step or add it to a campaign.' };
  }
}

function parseStepsSafe(steps: unknown): number | null {
  try { return parseSteps(steps).length || null; } catch { return null; }
}

/**
 * Contacts on an office, main or unknown line that a colleague opted out over (PLAN 8.2): the line is
 * suppressed for that colleague only, and shows here as "Shared line".
 */
async function sharedLines(contacts: Pick<SandboxContact, 'id' | 'status' | 'phone' | 'phoneType' | 'additionalPhones'>[]): Promise<Set<string>> {
  const byHash = new Map<string, string[]>();
  for (const c of contacts) {
    if (c.status !== 'ACTIVE') continue;
    const numbers = [...(c.phone && !personalPhone(c.phoneType) ? [c.phone] : []), ...readExtraPhones(c.additionalPhones).filter((p) => !personalPhone(p.type)).map((p) => p.number)];
    for (const n of numbers) { const h = suppressionHash('phone_subject', n); byHash.set(h, [...(byHash.get(h) ?? []), c.id]); }
  }
  if (!byHash.size) return new Set();
  const rows = await prisma.suppression.findMany({ where: { kind: 'phone_subject', valueHash: { in: [...byHash.keys()] } }, select: { valueHash: true, subjectId: true } });
  const out = new Set<string>();
  for (const r of rows) for (const id of byHash.get(r.valueHash) ?? []) if (r.subjectId !== id) out.add(id);
  return out;
}
