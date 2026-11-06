import type { ActionType } from '@prisma/client';
import { prisma } from '../db';
import type { SessionUser } from '../auth/current-user';
import { toActor } from '../auth/current-user';
import { canAssignSandbox, canChangeCampaignPeople, canManageEnrollment, isAdmin, isBizOps, isJuniorFo, mayChangeCampaignPeople, needsPod } from '../auth/rbac';
import { formatLocalDate, toLocalDate, todayIn, type LocalDate } from '../dates';
import { workspaceTimezone } from '../workspace';
import { getSettings } from '../settings';
import { describeAudit, type AuditField } from '../audit-format';
import { ACTION_LABELS, parseSteps } from '../sequences/steps';
import { shortDay } from '../task-cues';
import { canAct, effectiveOwner, loadColdSubject, optOutSourceWords, type Act, type ColdSubject, type Refusal } from '../outreach/guard';
import { contactability } from '../outreach/contactability';
import { assignableOwners } from '../outreach/ownership';
import { workWords } from '../outreach/transfer';
import { eraseConfirm, optOutConfirm, removeConfirm } from '../outreach/confirm-words';
import { callOutcomes } from '../call-outcomes';
import { openCallItems } from '../calls/link';
import { pendingFormBlock } from '../calls/gate';
import { pendingForms } from '../calls/form';
import { callTimeWords } from '../calls/words';
import { HIDDEN_CALL, mayHearCall } from '../calls/access';
import { formOptOut } from '../tickets';
import { openSuggestions } from '../outreach/suggestions';
import { mailTrackedFor } from '../mail/graph-mail';
import { coldRef, COLD_CONTACT_BASE, coldMoveHref, personRef, subjectHref } from '../subject';
import { COLD_TASKS_HREF } from '../tasks-query';
import { coldCues, type ColdCue } from './cues';
import { contactPathStep, type PathStepKey } from './path';
import { latestMoves, type ContactMove } from './moves-query';
import { crmChecklist, type ChecklistItem } from './ready';
import { countryChoices, linkedinHref, readExtraPhones } from './normalize';
import { NEXT_STEP_LABELS } from './history-notes';
import { PRODUCT_VALUES } from './bellwether-api';
import { detailsVersion } from './contacts';
import { campaignHolds } from './campaigns';

/*
 * The cold contact page (cold outreach PLAN 4.2), decided in one place: what the rep can do, why
 * not when they cannot (B089, B202), the one blocker with its fix (4.0), the tombstones (B108,
 * B150, N104) and every tab's rows. The page only draws this; the tests read it.
 */

/** The products a cold contact can be interested in, in their own words. */
export const PRODUCT_WORDS: Record<string, string> = { PHH: 'PHH', TOLLBOOTH: 'Tollbooth', ACUBOOTH: 'AcuBooth', GLYNAC: 'Glynac' };
export const productWords = (values: string[]) => values.map((v) => PRODUCT_WORDS[v] ?? v).join(', ');

const PHONE_TYPE_WORDS: Record<string, string> = { direct: 'Direct', mobile: 'Mobile', office: 'Office', main: 'Main line', toll_free: 'Toll free', unknown: 'Type unknown' };
export const phoneTypeWords = (t: string | null | undefined) => PHONE_TYPE_WORDS[t ?? 'unknown'] ?? 'Type unknown';

/** A number as people read it: "(646) 555-0499 ext. 7" for North America, else as dialled. */
export function phoneWords(e164: string | null | undefined, ext?: string | null): string | null {
  if (!e164) return null;
  const na = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return `${na ? `(${na[1]}) ${na[2]}-${na[3]}` : e164}${ext ? ` ext. ${ext}` : ''}`;
}

/** The email's verification in words and tone (B142). */
export function verificationWords(c: { email: string | null; emailVerification: string | null; badEmail: boolean; emailIsRole: boolean }): { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }[] {
  if (!c.email) return [];
  const out: { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }[] = [];
  if (c.badEmail) out.push({ label: 'Bounced', tone: 'amber' });
  else if (c.emailVerification === 'valid') out.push({ label: 'Verified', tone: 'green' });
  else if (c.emailVerification === 'risky') out.push({ label: 'Risky', tone: 'amber' });
  else if (c.emailVerification === 'invalid') out.push({ label: 'Invalid', tone: 'red' });
  else out.push({ label: 'Not checked', tone: 'gray' });
  if (c.emailIsRole) out.push({ label: 'Shared inbox', tone: 'gray' });
  return out;
}

const dayYear = (at: Date) => formatLocalDate(toLocalDate(at, workspaceTimezone()), 'year');

/** "Next: Call on Thu 5 Nov", the line every result ends with (PLAN 4.0), or what to do when there is none. */
export function nextWords(cue: Pick<ColdCue, 'state' | 'next'>, firstName: string): string | null {
  if (cue.next) return `Next: ${cue.next.label} on ${shortDay(cue.next.due)}${cue.next.overdue ? ' (overdue)' : ''}.`;
  switch (cue.state) {
    case 'unclaimed': return `Next: claim ${firstName} to work them.`;
    case 'no_next_step': return `Next: set a next step, or add ${firstName} to a campaign.`;
    case 'ready_to_move': return 'Next: Move to CRM.';
    case 'already_in_crm': return 'Next: Move to CRM to work them there.';
    default: return null;
  }
}

export type FixKind = 'form' | 'move' | 'claim' | 'assign' | 'next_step' | 'link';
/** The Notice above the buttons: the first thing in the way, and the one button that fixes it (4.0). */
export type Blocker = { tone: 'info' | 'warn' | 'error' | 'success'; text: string; fix: { kind: FixKind; label: string; href?: string } | null };

/** The top of a contact that is no longer worked here: moved, Do not contact, removed or erased. */
export type Banner =
  | { kind: 'moved'; text: string; personHref: string | null; undoUntil: string | null; move: ContactMove | null }
  | { kind: 'do_not_contact'; since: string | null; by: string | null; where: string; reason: string | null }
  | { kind: 'removed'; by: string; on: string | null; reason: string | null }
  | { kind: 'erased'; by: string; on: string | null };

export type HistoryItem = { key: string; at: Date; icon: string; title: string; detail?: string | null; fields?: AuditField[]; href?: string; recordingHref?: string | null; tone: 'in' | 'out' | 'neutral' };
export type TaskRow = { key: string; icon: string; label: string; where: string; when: string; state: 'open' | 'done' | 'skipped' | 'cancelled'; overdue: boolean; href?: string; fo: string | null; at: number };
export type StepWords = { id: string; label: string; words: string; tone: 'green' | 'blue' | 'amber' | 'gray' | 'red' };

function stepsIn(steps: unknown): number {
  try { return parseSteps(steps).length; } catch { return 0; }
}

/** Why a button is off, in the few words that fit under it (B089, B202). */
function shortWhy(v: Refusal, s: ColdSubject): string {
  switch (v.code) {
    case 'not_yours': return s.ownerName ? `${s.ownerName}'s contact` : 'Someone else\'s contact';
    case 'other_pod': return 'Not in your pods';
    case 'moving': return 'Being moved to the CRM';
    case 'read_only': return 'Read only';
    case 'claimed': return v.reason;
    default: return v.reason;
  }
}

/** Everything the contact page shows, for this reader. Null when there is no such contact. */
export async function loadContactPage(id: string, user: SessionUser, now = new Date()) {
  const contact = await prisma.sandboxContact.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, twentyMemberId: true, active: true } }, pod: { select: { id: true, name: true } },
      notes: { orderBy: { createdAt: 'desc' } }, emails: { orderBy: { at: 'desc' } },
      calls: { orderBy: { startedAt: 'desc' }, include: { form: true, user: { select: { name: true } } } },
      nextActions: { where: { personId: null }, orderBy: { createdAt: 'desc' }, include: { fo: { select: { id: true, name: true } } } },
      enrollments: { orderBy: { createdAt: 'desc' }, include: { fo: { select: { name: true } }, campaign: { select: { id: true, name: true, status: true } }, sequence: { select: { name: true, steps: true } }, tasks: { orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }], include: { fo: { select: { name: true } } } } } },
    },
  });
  if (!contact) return null;
  const actor = toActor(user);
  const today = todayIn(user.timezone, now);
  const settings = await getSettings();
  const enrollmentIds = contact.enrollments.map((e) => e.id);
  const [subject, cues, moves, owners, upcoming, audits, pushes, version, pods, suggestions] = await Promise.all([
    loadColdSubject(id), coldCues([id], { today }), latestMoves([id], actor, now), assignableOwners(user),
    // B144: a campaign that has not started holds the contact in its list, unless it is a draft (S7:
    // drafts hold nobody, the rule coldAudienceIssues applies). A draft is shown as one, holding nothing.
    prisma.campaign.findMany({ where: { audience: 'SANDBOX', status: { in: ['SCHEDULED', 'DRAFT'] }, personIds: { has: id } }, orderBy: [{ startDate: 'asc' }], select: { id: true, name: true, status: true, startDate: true, podId: true, pod: { select: { name: true } }, plannerDraft: true, enrollments: { distinct: ['foUserId'], select: { foUserId: true } } } }),
    prisma.auditLog.findMany({ where: { OR: [{ entityType: 'sandbox_contact', entityId: id }, ...(enrollmentIds.length ? [{ entityType: 'enrollment', entityId: { in: enrollmentIds } }] : [])] }, orderBy: { createdAt: 'desc' }, take: 300 }),
    prisma.bellwetherPushItem.findMany({ where: { sandboxContactId: id }, orderBy: { createdAt: 'asc' }, include: { push: { select: { pushedByEmail: true, createdAt: true } } } }),
    detailsVersion(id),
    prisma.pod.findMany({ where: { archived: false, ...(isAdmin(user) ? {} : { id: { in: user.podIds } }) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    openSuggestions(user.id, { sandboxContactId: id }),
  ]);
  const cue = cues.get(id)!;
  const s = subject!;
  const move = moves.get(id) ?? null;
  const live = contact.status === 'ACTIVE';
  const erased = Boolean(contact.erasedAt) || (contact.status === 'OPTED_OUT' && Boolean(contact.piiClearedAt));
  const removed = contact.status === 'REMOVED';
  const firstName = contact.firstName.trim() || 'this contact';
  const name = `${contact.firstName} ${contact.lastName}`.trim() || (erased ? 'Erased contact' : removed ? 'Removed contact' : 'Contact');
  const admin = isAdmin(user);
  const bizOps = isBizOps(user);
  const unclaimed = !effectiveOwner(s);
  const verdict = (act: Act) => canAct(actor, s, act);
  const work = verdict('edit');
  const claimV = verdict('claim');
  // B149: an unclaimed contact is Claim-only for reps; admins work any contact without owning it.
  const claimFirst = live && unclaimed && !admin && work.ok;
  const mayClaim = live && unclaimed && claimV.ok;
  const mayWork = live && work.ok && !claimFirst;
  const workWhy = !live ? null : !work.ok ? shortWhy(work, s) : claimFirst ? 'Claim first' : null;

  // Names: whoever acted, pushed, removed or erased.
  const pushers = [...new Set(pushes.map((p) => p.push.pushedByEmail.toLowerCase()).concat(contact.pushedByEmail ? [contact.pushedByEmail.toLowerCase()] : []))];
  const userIds = [...new Set([...audits.map((a) => a.actorId), contact.removedById, contact.createdById, contact.movedById].filter((x): x is string => Boolean(x)))];
  const people = await prisma.user.findMany({ where: { OR: [{ id: { in: userIds } }, ...(pushers.length ? [{ email: { in: pushers, mode: 'insensitive' as const } }] : [])] }, select: { id: true, name: true, email: true } });
  const userName = new Map(people.map((u) => [u.id, u.name]));
  // B205: the pusher by name, never by email.
  const pusherName = (email: string | null | undefined) => (email ? people.find((u) => u.email.toLowerCase() === email.toLowerCase())?.name ?? (email.toLowerCase() === contact.pushedByEmail?.toLowerCase() ? contact.pushedByName : null) ?? email.split('@')[0] : null);
  const actorWords = (a: { actorType: string; actorId: string | null; actorLabel: string | null }) => {
    if (a.actorId && userName.get(a.actorId)) return userName.get(a.actorId)!;
    if (a.actorLabel?.startsWith('bellwether:')) return `${pusherName(a.actorLabel.slice('bellwether:'.length)) ?? 'someone'} (Bellwether)`;
    if (a.actorLabel?.startsWith('twenty:')) return 'the CRM';
    return a.actorLabel ?? 'Cadence';
  };

  // Header: "Title · Firm · Owner · Pod" (B141); a tombstone keeps no owner or pod (B150).
  const ownerWords = contact.owner ? `${contact.owner.name}${contact.owner.active ? '' : ' (left)'}` : 'Unclaimed';
  const sub = contact.piiClearedAt ? 'Details cleared' : [contact.jobTitle, contact.companyName, live || contact.status === 'MOVED' ? ownerWords : null, contact.pod?.name].filter(Boolean).join(' · ');
  const newerNote = contact.notes.find((n) => n.body.startsWith('Newer details from Bellwether'));

  // The checks a press would run (8.2): what blocks outreach at all, and what blocks a call now.
  const [outreach, callCheck, pendingBlock, myForms] = live ? await Promise.all([
    contactability(coldRef(id), { act: 'next_step', now }),
    contact.phone ? contactability(coldRef(id), { act: 'call', channel: 'CALL', user, now }) : Promise.resolve(null),
    pendingFormBlock(user.id, user.timezone, now),
    pendingForms(user.id),
  ]) : [null, null, null, []];
  // Under a button the waiting form is named without its time; the notice above says when (4.0).
  const shortForm = (reason: string | null) => reason?.replace(/ \([^)]*\) first\.$/, ' first.') ?? null;
  const outreachWhy = outreach && !outreach.ok ? (outreach.block === 'in_crm' ? 'Outreach stopped: in the CRM' : outreach.block === 'inactive' ? outreach.reason : 'Do not contact') : null;

  // The button row (B141): Call, Email, LinkedIn, Log a call, Set next step, Move to CRM, More.
  const sales = !bizOps && (admin || needsPod(user.role));
  const call = {
    show: live && sales,
    phone: contact.phone,
    claim: claimFirst && mayClaim && Boolean(contact.phone),
    blocked: !contact.phone ? 'No phone number: add one' : !work.ok ? shortWhy(work, s) : claimFirst && !mayClaim ? (claimV.ok ? null : claimV.reason) : callCheck && !callCheck.ok ? shortForm(callCheck.reason) : null,
    // N073: a number marked wrong asks before the dialpad opens; so does a calling-hours warning.
    warning: callCheck && callCheck.ok ? [callCheck.confirm ? 'This number was marked wrong on a call. Call it anyway?' : null, callCheck.warning].filter(Boolean).join(' ') || null : null,
    nextActionId: contact.nextActions.find((n) => n.state === 'OPEN')?.id ?? null,
  };
  const email = {
    show: live && sales,
    href: contact.email ? `mailto:${contact.email}` : null,
    blocked: workWhy ?? outreachWhy ?? (!contact.email ? 'No email: add one' : contact.badEmail ? 'Email bounced: find a new one' : null),
  };
  const linkedin = {
    show: live && sales,
    href: linkedinHref(contact.linkedinUrl),
    blocked: workWhy ?? outreachWhy ?? (!contact.linkedinUrl ? 'No LinkedIn profile: add one' : null),
  };
  const logCall = {
    show: live && sales,
    blocked: workWhy ?? shortForm(pendingBlock),
    steps: mayWork ? (await openCallItems({ personId: null, sandboxContactId: id }, null)).map((st) => ({ key: `${st.kind}:${st.id}`, words: st.words })) : [],
  };
  const open = contact.nextActions.find((n) => n.state === 'OPEN') ?? null;
  const nextStep = {
    show: live && sales,
    blocked: workWhy ?? outreachWhy,
    open,
  };
  const moveV = verdict('move');
  const move_ = {
    show: live && sales,
    ready: cue.state === 'ready_to_move',
    blocked: moveV.ok ? null : !work.ok ? shortWhy(work, s) : claimFirst || (unclaimed && moveV.code === 'not_allowed' && !admin) ? 'Claim first' : shortWhy(moveV, s),
  };
  const mayAssign = owners.length > 0 && canAssignSandbox(actor, contact, null) && (admin || !isJuniorFo(user)) && (live ? verdict('assign').ok : false);
  const mayRelease = live && isJuniorFo(user) && contact.ownerId === user.id && verdict('release').ok;
  const optV = verdict('opt_out');
  const removeV = verdict('remove');
  const more = {
    show: sales && !erased && contact.status !== 'MOVED' && !(contact.status === 'OPTED_OUT' && !admin),
    mayAssign, mayRelease,
    mayOptOut: optV.ok && contact.status !== 'OPTED_OUT',
    mayRemove: live && removeV.ok,
    mayErase: admin && contact.status !== 'MOVED' && !erased,
    whyNot: {
      ...(live && !mayAssign && !isJuniorFo(user) && owners.length && !verdict('assign').ok ? { assign: shortWhy(verdict('assign') as Refusal, s) } : {}),
      ...(live && !removeV.ok ? { remove: shortWhy(removeV, s) } : {}),
    } as Partial<Record<'assign' | 'release' | 'opt_out' | 'remove' | 'erase', string>>,
  };

  // The blocker (4.0): the first thing in the way, said once, with its one fix.
  const crmPersonId = contact.crmMatchPersonId ?? contact.crmAutoPersonId;
  const [crmPerson, possibleCrm, twin] = await Promise.all([
    crmPersonId ? prisma.personCache.findUnique({ where: { id: crmPersonId }, select: { id: true, firstName: true, lastName: true, ownerMemberId: true } }) : null,
    contact.possibleCrmPersonId ? prisma.personCache.findUnique({ where: { id: contact.possibleCrmPersonId }, select: { id: true, firstName: true, lastName: true, ownerMemberId: true, companyName: true } }) : null,
    contact.possibleDuplicateId ? prisma.sandboxContact.findUnique({ where: { id: contact.possibleDuplicateId }, select: { id: true, firstName: true, lastName: true, status: true, owner: { select: { name: true } } } }) : null,
  ]);
  const memberIds = [crmPerson?.ownerMemberId, possibleCrm?.ownerMemberId].filter((x): x is string => Boolean(x));
  const members = memberIds.length ? await prisma.user.findMany({ where: { twentyMemberId: { in: memberIds } }, select: { twentyMemberId: true, name: true } }) : [];
  const memberName = (m: string | null | undefined) => members.find((u) => u.twentyMemberId === m)?.name ?? null;
  let blocker: Blocker | null = null;
  if (live) {
    const pendingNow = myForms[0];
    const pendingWho = pendingNow ? (pendingNow.person ?? pendingNow.sandboxContact) : null;
    if (s.moving) blocker = { tone: 'info', text: `Moving ${firstName} to the CRM… The contact is locked until the move ends.`, fix: move ? { kind: 'link', label: 'See the move', href: coldMoveHref(move.moveId) } : null };
    else if (!work.ok) blocker = { tone: 'info', text: work.reason, fix: null };
    else if (move?.state === 'FAILED') blocker = { tone: 'error', text: `Move failed: ${move.error ?? 'see the move'}.`, fix: { kind: 'link', label: move.failure === 'permanent' ? 'See the move' : 'Move again', href: coldMoveHref(move.moveId) } };
    else if (pendingNow && sales) blocker = { tone: 'warn', text: `Your call with ${pendingWho ? `${pendingWho.firstName} ${pendingWho.lastName}`.trim() || 'a removed contact' : (pendingNow.direction === 'INBOUND' ? pendingNow.fromNumber : pendingNow.toNumber) ?? 'an unknown number'} (${callTimeWords(pendingNow.startedAt ?? pendingNow.createdAt, user.timezone, now)}) needs its form before you can call again.`, fix: { kind: 'form', label: 'Fill it in' } };
    else if (outreach && !outreach.ok && outreach.block === 'in_crm') blocker = { tone: 'info', text: `${firstName} is in the CRM already (${crmPerson ? `${crmPerson.firstName} ${crmPerson.lastName}`.trim() : 'a CRM person'}${memberName(crmPerson?.ownerMemberId) ? `, ${memberName(crmPerson?.ownerMemberId)}` : ''}). Outreach stopped.`, fix: !move_.blocked ? { kind: 'move', label: 'Move to CRM' } : null };
    else if (outreach && !outreach.ok) blocker = { tone: 'error', text: `${outreach.reason} Do not email, call or message this person.`, fix: null };
    else if (contact.owner && !contact.owner.active) blocker = { tone: 'warn', text: `${contact.owner.name} has left, so ${firstName} needs a new owner.`, fix: mayAssign ? { kind: 'assign', label: 'Assign' } : mayClaim ? { kind: 'claim', label: 'Claim' } : null };
    else if (unclaimed) blocker = admin
      ? { tone: 'warn', text: `Nobody owns ${firstName} yet. Admins do not own contacts: give ${firstName} to a rep.`, fix: mayAssign ? { kind: 'assign', label: 'Assign' } : null }
      : mayClaim ? { tone: 'warn', text: `Nobody owns ${firstName} yet. Claim ${firstName} to call, email or set a next step.`, fix: { kind: 'claim', label: 'Claim' } }
      : { tone: 'info', text: claimV.ok ? `Nobody owns ${firstName} yet.` : claimV.reason, fix: null };
    else if (cue.state === 'closed') blocker = { tone: 'info', text: `${cue.badge.label}. Set a new next step to reopen ${firstName}, or opt them out.`, fix: mayWork && !nextStep.blocked ? { kind: 'next_step', label: 'Set next step' } : null };
    else if (cue.state === 'no_next_step') blocker = { tone: 'warn', text: `${firstName} has no next step. Set one, or add ${firstName} to a campaign.`, fix: mayWork && !nextStep.blocked ? { kind: 'next_step', label: 'Set next step' } : null };
    else if (cue.state === 'ready_to_move') blocker = { tone: 'success', text: `Ready to move: CRM details complete, and a positive outcome${cue.positive ? ` (${cue.positive})` : ''}.`, fix: !move_.blocked ? { kind: 'move', label: 'Move to CRM' } : null };
  }

  // The tombstones (B108, N104, B150).
  let banner: Banner | null = null;
  const lastAudit = (action: string) => audits.find((a) => a.action === action && a.entityType === 'sandbox_contact') ?? null;
  if (contact.status === 'MOVED') {
    const mover = move?.moverName ?? (contact.movedById ? userName.get(contact.movedById) ?? null : null);
    banner = { kind: 'moved', text: `Moved to the CRM${mover ? ` by ${mover}` : ''}${contact.movedAt ? ` on ${dayYear(contact.movedAt)}` : ''}${move?.mode === 'attach' && move.personName ? `, as history on ${move.personName}` : ''}`, personHref: contact.twentyPersonId ? subjectHref(personRef(contact.twentyPersonId)) : null, undoUntil: move?.undoUntil ?? null, move };
  } else if (erased) {
    const a = lastAudit('erased');
    banner = { kind: 'erased', by: a ? actorWords(a) : 'An admin', on: contact.erasedAt ? dayYear(contact.erasedAt) : contact.piiClearedAt ? dayYear(contact.piiClearedAt) : null };
  } else if (contact.status === 'OPTED_OUT') {
    const a = lastAudit('opted_out');
    banner = { kind: 'do_not_contact', since: contact.optedOutAt ? dayYear(contact.optedOutAt) : null, by: a ? actorWords(a) : null, where: optOutSourceWords(contact.optOutSource), reason: contact.optOutReason && contact.optOutReason !== contact.optOutSource ? contact.optOutReason : null };
  } else if (removed) {
    const a = lastAudit('removed');
    const byUser = contact.removedById ? userName.get(contact.removedById) ?? 'Someone' : a && (a.details as { by?: string } | null)?.by === 'user' ? actorWords(a) : null;
    banner = { kind: 'removed', by: byUser ?? 'Cadence (no activity for a long time)', on: contact.piiClearedAt ? dayYear(contact.piiClearedAt) : dayYear(contact.statusChangedAt), reason: contact.removedReason };
  }
  const formOpt = contact.status === 'OPTED_OUT' && !contact.piiClearedAt ? await formOptOut(coldRef(id)) : null;

  // Overview: the checklist (B104, B154, B155, B050).
  const ownerPods = contact.ownerId && contact.owner?.active ? (await prisma.userPod.findMany({ where: { userId: contact.ownerId, pod: { archived: false } }, select: { podId: true } })).map((p) => p.podId) : null;
  const podChoices = mayWork ? pods.filter((p) => !ownerPods || ownerPods.includes(p.id)) : [];
  const check = crmChecklist(cue.readiness, settings.sandbox);
  const checklist = live ? {
    ...check,
    items: check.items as ChecklistItem[],
    state: cue.state === 'ready_to_move' ? 'ready' as const : cue.readiness.ready ? 'complete' as const : 'missing' as const,
    positive: cue.positive,
    warnings: cue.readiness.warnings.map((w) => w.text),
    // A pod picker where the pod is missing, or the owner works in several pods (B050).
    podPicker: podChoices.length && (!contact.podId || podChoices.length > 1) ? podChoices : null,
  } : null;

  // Details (B142).
  const extraPhones = readExtraPhones(contact.additionalPhones);
  // Source (B205, B143, B017, B068): who pushed and when, later pushes, possible matches.
  const firstPush = pushes[0] ?? null;
  const laterPushes = pushes.slice(1).map((p) => ({ by: pusherName(p.push.pushedByEmail), email: p.push.pushedByEmail, on: dayYear(p.push.createdAt), result: p.result }));
  const source = {
    kind: contact.source,
    by: contact.source === 'BELLWETHER' ? contact.pushedByName ?? pusherName(contact.pushedByEmail) : contact.createdById ? userName.get(contact.createdById) ?? null : null,
    byEmail: contact.pushedByEmail,
    on: dayYear(firstPush?.push.createdAt ?? contact.createdAt),
    collected: contact.collectedAt ? formatLocalDate(contact.collectedAt, 'year') : null,
    note: contact.sourceNote,
    later: laterPushes,
    bellwetherUrl: contact.bellwetherUrl,
    possibleCrm: possibleCrm && !contact.crmMatchPersonId && !contact.crmAutoPersonId ? { name: `${possibleCrm.firstName} ${possibleCrm.lastName}`.trim(), owner: memberName(possibleCrm.ownerMemberId), firm: possibleCrm.companyName, href: subjectHref(personRef(possibleCrm.id)) } : null,
    possibleTwin: twin ? { name: `${twin.firstName} ${twin.lastName}`.trim() || 'another contact', owner: twin.owner?.name ?? null, status: twin.status, href: subjectHref(coldRef(twin.id)) } : null,
    newerNote: newerNote ? { id: newerNote.id, href: `${subjectHref(coldRef(id))}?tab=notes#note-${newerNote.id}` } : null,
    inCrm: crmPerson ? { name: `${crmPerson.firstName} ${crmPerson.lastName}`.trim(), owner: memberName(crmPerson.ownerMemberId), href: subjectHref(personRef(crmPerson.id)) } : null,
  };

  // Campaigns (B144, B145): holds of campaigns not started yet, and every enrollment.
  const enrolledIn = new Set(contact.enrollments.map((e) => e.campaignId).filter(Boolean));
  const mayTakeOut = (c: (typeof upcoming)[number]) => live && canChangeCampaignPeople(actor, { podId: c.podId, foIds: [...new Set([...((c.plannerDraft as { fos?: { id: string }[] } | null)?.fos ?? []).map((f) => f.id), ...c.enrollments.map((e) => e.foUserId)])] });
  const holds = upcoming.filter((c) => campaignHolds(c.status) && !enrolledIn.has(c.id)).map((c) => ({ id: c.id, name: c.name, words: `starts ${shortDay(c.startDate)}`, mayRemove: mayTakeOut(c) }));
  // In a draft's list, but a draft holds nobody: "In draft: Q4 Harbor (not started)".
  const drafts = upcoming.filter((c) => !campaignHolds(c.status)).map((c) => ({ id: c.id, name: c.name, mayRemove: mayTakeOut(c) }));
  const memberships = contact.enrollments.map((e) => {
    const steps = e.tasks.map<StepWords>((t) => ({
      id: t.id, label: t.label,
      words: t.state === 'DONE' ? `Done${t.completedAt ? ` ${formatLocalDate(toLocalDate(t.completedAt, user.timezone))}` : ''}` : t.state === 'SKIPPED' ? `Skipped${t.skipReason ? `: ${t.skipReason}` : ''}` : t.state === 'PENDING' ? `${(t.snoozedTo ?? t.dueDate) < today ? 'Overdue' : 'Due'} ${shortDay(t.snoozedTo ?? t.dueDate)}` : 'Cancelled',
      tone: t.state === 'DONE' ? 'green' : t.state === 'SKIPPED' ? 'amber' : t.state === 'PENDING' ? ((t.snoozedTo ?? t.dueDate) < today ? 'red' : 'blue') : 'gray',
    }));
    const stepCount = stepsIn(e.sequence.steps);
    const running = e.status === 'ACTIVE' || e.status === 'PAUSED';
    return {
      id: e.id, campaignId: e.campaign?.id ?? null, name: e.campaign?.name ?? e.sequence.name, status: e.status, exitReason: e.exitReason, fo: e.fo.name, started: formatLocalDate(e.startDate), stepCount,
      stepAt: running && e.currentStep >= 0 ? Math.min(e.currentStep + 1, stepCount || e.currentStep + 1) : null, steps, running,
      mayManage: live && running && canManageEnrollment(actor, e),
    };
  });
  const mayEnroll = live && !bizOps && mayChangeCampaignPeople(user) && verdict('enroll').ok;

  // Tasks: open and done steps and next steps.
  const taskTab = (due: LocalDate) => (due < today ? 'overdue' : due === today ? 'today' : 'upcoming');
  const tasks: TaskRow[] = [
    ...contact.enrollments.flatMap((e) => e.tasks.map<TaskRow>((t) => {
      const due = t.snoozedTo ?? t.dueDate;
      const state = t.state === 'PENDING' ? 'open' : t.state === 'DONE' ? 'done' : t.state === 'SKIPPED' ? 'skipped' : 'cancelled';
      return { key: `t${t.id}`, icon: t.action, label: t.label, where: e.campaign?.name ?? e.sequence.name, when: state === 'open' ? `${due < today ? 'Overdue' : 'Due'} ${shortDay(due)}` : state === 'done' ? `Done${t.completedAt ? ` ${formatLocalDate(toLocalDate(t.completedAt, user.timezone))}` : ''}` : state === 'skipped' ? `Skipped${t.skipReason ? `: ${t.skipReason}` : ''}` : 'Cancelled', state, overdue: state === 'open' && due < today, href: state === 'open' && live ? `${COLD_TASKS_HREF}?task=${t.id}&mode=flow&tab=${taskTab(due)}` : undefined, fo: t.fo.name, at: state === 'open' ? Date.parse(`${due}T12:00:00Z`) : (t.completedAt ?? t.updatedAt).getTime() };
    })),
    ...contact.nextActions.map<TaskRow>((n) => {
      const state = n.state === 'OPEN' ? 'open' : n.state === 'DONE' ? 'done' : 'cancelled';
      const how = n.kind === 'MEETING' ? 'Meeting' : ACTION_LABELS[n.action as ActionType];
      return { key: `n${n.id}`, icon: n.kind === 'MEETING' ? 'MEETING' : n.action, label: n.label === how ? how : `${how}: ${n.label}`, where: 'Next step', when: state === 'open' ? `${n.dueDate < today ? 'Overdue' : 'Due'} ${shortDay(n.dueDate)}` : state === 'done' ? `Done${n.lastDoneAt ?? n.closedAt ? ` ${formatLocalDate(toLocalDate((n.lastDoneAt ?? n.closedAt)!, user.timezone))}` : ''}` : 'Cancelled', state, overdue: state === 'open' && n.dueDate < today, href: state === 'open' && live ? `${COLD_TASKS_HREF}?next=${n.id}&tab=${taskTab(n.dueDate)}` : undefined, fo: n.fo.name, at: state === 'open' ? Date.parse(`${n.dueDate}T12:00:00Z`) : (n.closedAt ?? n.updatedAt).getTime() };
    }),
  ];

  // Activity (B140): every event, calls with their form, notes, emails, steps, and the audit trail.
  const outcomes = callOutcomes(settings.rules);
  const hears = (c: (typeof contact.calls)[number]) => mayHearCall(actor, { userId: c.userId, formUserId: c.formUserId, ownerId: contact.ownerId });
  const QUIET = new Set(['note_added', 'step_generated']);
  const history: HistoryItem[] = [
    ...contact.calls.filter((c) => !c.discardedAt).map<HistoryItem>((c) => {
      const outcome = c.form ? outcomes.find((o) => o.key === c.form!.outcome)?.label ?? c.form.outcome : null;
      const heard = hears(c);
      return {
        key: `c${c.id}`, at: c.startedAt ?? c.createdAt, icon: 'CALL', tone: c.direction === 'INBOUND' ? 'in' : 'out', href: `/calls/${c.id}`,
        title: `${c.direction === 'OUTBOUND' ? 'Call' : `Call from ${firstName} (incoming)`}${c.talkSec ? ` · ${Math.floor(c.talkSec / 60)}m ${c.talkSec % 60}s` : ''} by ${c.user?.name ?? 'an unknown rep'}${outcome ? ` · ${outcome}` : c.formDueAt && !c.formDoneAt ? ' · form due' : ''}`,
        // N051: the form's notes and the recording only for the rep, the owner and Reports viewers.
        detail: c.form?.notes ? (heard ? c.form.notes : HIDDEN_CALL) : null,
        fields: c.form ? [...(c.form.rating ? [{ label: 'Rating', value: `${c.form.rating}/5` }] : []), ...(c.form.interest ? [{ label: 'Interest', value: c.form.interest }] : []), { label: 'Next', value: `${c.form.nextStepLabel ?? NEXT_STEP_LABELS[c.form.nextStep] ?? c.form.nextStep}${c.form.nextStepDate ? `, ${formatLocalDate(c.form.nextStepDate)}` : ''}` }] : [],
        recordingHref: c.recordingSid && heard ? `/api/calls/${c.id}/recording` : null,
      };
    }),
    ...contact.emails.map<HistoryItem>((m) => ({ key: `m${m.id}`, at: m.at, icon: 'EMAIL', tone: m.kind === 'SENT' ? 'out' : 'in', title: `${m.kind === 'SENT' ? 'Email sent' : m.kind === 'REPLY' ? 'Reply' : m.kind === 'BOUNCE' ? 'Email bounced' : 'Auto-reply'}${m.subject ? `: ${m.subject}` : ''}` })),
    ...contact.notes.map<HistoryItem>((n) => ({ key: `n${n.id}`, at: n.createdAt, icon: 'NOTE', tone: 'neutral', title: `Note by ${n.authorName ?? 'Cadence'}`, detail: n.body, href: `${subjectHref(coldRef(id))}?tab=notes#note-${n.id}` })),
    ...contact.enrollments.flatMap((e) => e.tasks.filter((t) => t.state === 'DONE' || t.state === 'SKIPPED').map<HistoryItem>((t) => ({ key: `t${t.id}`, at: t.completedAt ?? t.updatedAt, icon: t.action, tone: 'out', title: `${t.label} ${t.state === 'DONE' ? 'done' : 'skipped'}${t.skipReason ? `: ${t.skipReason}` : ''} · ${e.campaign?.name ?? e.sequence.name}`, detail: t.note }))),
    ...audits.filter((a) => !QUIET.has(a.action)).map<HistoryItem>((a) => {
      const words = describeAudit(a.action, a.details as Record<string, unknown> | null, actorWords(a), a.entityType);
      // A cold contact's next action is its next step, in the section's own words.
      const title = a.entityType === 'sandbox_contact' ? words.title.replace(/^Task /, 'Next step ') : words.title;
      return { key: `a${a.id}`, at: a.createdAt, icon: 'STATE', tone: 'neutral', title, fields: words.fields };
    }),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  // Emails (W10): what Outlook tracking saw, newest first; or, with tracking off, the steps marked Done.
  const tracked = contact.ownerId ? (await mailTrackedFor([contact.ownerId])).has(contact.ownerId) : false;
  const mailboxNames = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(contact.emails.map((m) => m.userId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const emails = contact.emails.map((m) => ({ id: m.id, kind: m.kind, subject: m.subject, at: m.at, mailbox: m.userId ? mailboxNames.get(m.userId) ?? null : null }));
  const emailSteps = contact.enrollments.flatMap((e) => e.tasks.filter((t) => t.action === 'EMAIL' && t.state === 'DONE' && !contact.emails.some((m) => m.taskId === t.id)).map((t) => ({ id: t.id, label: t.label, where: e.campaign?.name ?? e.sequence.name, at: t.completedAt ?? t.updatedAt, by: t.fo.name })));

  const effects = { name, campaigns: memberships.filter((m) => m.running).map((m) => m.name), nextStep: open ? `${ACTION_LABELS[open.action as ActionType]} on ${formatLocalDate(open.dueDate)}` : null, fromBellwether: contact.source === 'BELLWETHER', inCrm: contact.status === 'MOVED' };
  const running = contact.enrollments.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED');

  return {
    contact, id, name, firstName, live, erased, removed, sub, cue, step: contactPathStep(cue) as PathStepKey | null, today, settings,
    newerNote: source.newerNote, possibleBounce: live && contact.possibleBounceAt && !contact.badEmail ? { at: contact.possibleBounceAt, on: dayYear(contact.possibleBounceAt), mayAct: work.ok } : null,
    banner, formOpt, blocker, mayWork, mayClaim, claimFirst, workWhy, admin, bizOps, sales,
    readOnly: live && !work.ok ? work.reason : null,
    /** The one line under a row of buttons that are all off for the same reason. */
    readOnlyLine: live && !work.ok ? (work.code === 'moving' ? 'Being moved to the CRM: the buttons come back if the move fails.' : work.code === 'not_yours' || work.code === 'other_pod' ? `${shortWhy(work, s)}: you can read it, and opt them out if they ask, but not work it.` : work.reason) : null,
    call, email, linkedin, logCall, nextStep, move: move_, more, owners, pods, moveItem: move,
    work: workWords({ nextSteps: contact.nextActions.filter((n) => n.state === 'OPEN').length, enrollments: running.length, tasks: running.reduce((k, e) => k + e.tasks.filter((t) => t.state === 'PENDING').length, 0) }),
    confirms: { optOut: optOutConfirm(effects), remove: removeConfirm(effects), erase: eraseConfirm(effects) },
    checklist, edit: { may: mayWork, why: workWhy ?? (live ? null : contact.status === 'MOVED' ? 'Moved to the CRM: edit them in People' : contact.status === 'OPTED_OUT' ? 'Do not contact: kept read only' : 'Not in Cold outreach any more'), version },
    details: { extraPhones, verification: verificationWords(contact), products: productWords(contact.productInterest) },
    source, holds, drafts, memberships, mayEnroll, tasks, history, emails, emailSteps, tracked, suggestions,
    nextLine: live ? nextWords(cue, firstName) : null,
    countries: countryChoices(), productChoices: PRODUCT_VALUES.map((v) => ({ value: v, label: PRODUCT_WORDS[v] ?? v })),
    contactsHref: COLD_CONTACT_BASE,
  };
}

export type ContactPage = NonNullable<Awaited<ReturnType<typeof loadContactPage>>>;
