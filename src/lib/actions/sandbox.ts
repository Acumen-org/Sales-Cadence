'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canManageSettings, needsPod, isAdmin } from '../auth/rbac';
import { userActor } from '../audit';
import { isLocalDate, todayIn } from '../dates';
import { addNote, assignContact, claimContact, createContact, eraseContact, removeContact, setContactPod, updateContact, type ContactInput } from '../sandbox/contacts';
import { suppressValue } from '../sandbox/opt-out';
import { normalizedFor, type SuppressionKind } from '../sandbox/suppression';
import { setColdNextStep } from '../sandbox/work';
import { optOutContact } from '../outreach/transitions';
import { NEXT_ACTION_CHANNELS, pushNextAction } from '../next-actions';
import { reassignStrandedNextActions } from '../outreach/ownership';
import { afterResponse } from '../engine/sync-out';
import { clearPossibleBounce, confirmPossibleBounce } from '../mail/cold-email';
import type { ActionType } from '@prisma/client';
import type { ActionResult } from './users';
import { COLD_CONTACT_BASE, coldRef, subjectHref } from '@/lib/subject';

/**
 * Cold outreach's server actions. Every one goes through the guard (src/lib/outreach/guard.ts) with
 * the signed-in user, so a stale tab, another pod or Biz Ops is refused with the reason in words, and
 * nothing is changed (B008, B009, B048, B053).
 */

function refresh(id?: string) {
  revalidatePath(COLD_CONTACT_BASE, 'layout');
  if (id) revalidatePath(subjectHref(coldRef(id)));
}

const field = (fd: FormData, k: string) => (fd.has(k) ? String(fd.get(k) ?? '') : undefined);

function contactInput(fd: FormData): Partial<ContactInput> {
  const input: Partial<ContactInput> = {};
  for (const k of ['firstName', 'lastName', 'jobTitle', 'email', 'phone', 'phoneExtension', 'phoneType', 'linkedinUrl', 'city', 'state', 'country', 'companyName', 'companyWebsite', 'companyCrd', 'individualCrd'] as const) {
    const v = field(fd, k);
    if (v !== undefined) (input as Record<string, unknown>)[k] = v;
  }
  if (fd.has('productInterest')) input.productInterest = fd.getAll('productInterest').map(String).filter(Boolean);
  return input;
}

/** Add contact. A refusal for the same name at the same firm names the other contact (B139). */
export async function createContactAction(fd: FormData): Promise<ActionResult & { possibleDuplicate?: string }> {
  const user = await requireUser();
  if (!isAdmin(user) && !needsPod(user.role)) return { ok: false, error: 'Biz Ops can view cold contacts but cannot add them.' };
  const r = await createContact(contactInput(fd) as ContactInput, { id: user.id, podIds: user.podIds, ownsContacts: needsPod(user.role) || isAdmin(user) }, userActor(user), field(fd, 'podId') || null, { addAnyway: field(fd, 'addAnyway') === '1' });
  refresh();
  return r.ok ? { ok: true, message: 'Added to Cold outreach.', redirectTo: subjectHref(coldRef(r.id)) } : r;
}

/**
 * The contact page's Edit dialog: only the fields that changed, and the version it loaded (B052,
 * N024). A same-name twin at the firm comes back with its id, for "Open that contact" (B139).
 */
export async function updateContactAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(fd.get('id') ?? '');
  const r = await updateContact(id, contactInput(fd), userActor(user), toActor(user), { version: field(fd, 'version') ?? null, timezone: user.timezone, saveAnyway: field(fd, 'saveAnyway') === '1' });
  refresh(id);
  if (!r.ok) return r.possibleDuplicate ? { ok: false, error: r.error, data: { possibleDuplicate: r.possibleDuplicate } } as ActionResult : { ok: false, error: r.error };
  return { ok: true, message: r.unchanged ? 'Nothing had changed.' : 'Saved.' };
}

/** Many contacts, each through the guard on its own; the refusals are named, not swallowed. */
function summary(done: number, refused: string[], verb: string): ActionResult {
  const reasons = [...new Set(refused)];
  if (!done) return { ok: false, error: reasons[0] ?? 'Nothing was changed.' };
  return { ok: true, message: `${verb} ${done}.${refused.length ? ` ${refused.length} not changed: ${reasons.slice(0, 2).join(' ')}` : ''}`, data: { refused: refused.length } };
}

export async function claimContactsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = fd.getAll('ids').map(String).filter(Boolean);
  let claimed = 0;
  const refused: string[] = [];
  for (const id of ids) {
    const r = await claimContact(id, { id: user.id, podIds: user.podIds, role: user.role }, userActor(user), field(fd, 'podId') || null);
    if (r.ok) claimed++; else refused.push(r.error);
  }
  refresh(ids.length === 1 ? ids[0] : undefined);
  return summary(claimed, refused, 'Claimed');
}

/**
 * Assign (or release). Each contact goes through transferContact with its work (B049); `owner:<id>`
 * carries the owner the page showed, so a claim that landed since is never taken away (N076).
 */
export async function assignContactsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = fd.getAll('ids').map(String).filter(Boolean);
  const to = String(fd.get('userId') ?? '') || null;
  let done = 0;
  const refused: string[] = [];
  const moved: string[] = [];
  for (const id of ids) {
    const seen = fd.has(`owner:${id}`) ? String(fd.get(`owner:${id}`) ?? '') || null : undefined;
    const r = await assignContact(id, to, userActor(user), field(fd, 'podId') || null, toActor(user), seen);
    if (r.ok) { done++; if (r.moved) moved.push(r.moved); } else refused.push(r.error);
  }
  refresh(ids.length === 1 ? ids[0] : undefined);
  const r = summary(done, refused, to ? 'Assigned' : 'Released');
  return r.ok && moved.length && ids.length === 1 ? { ...r, message: `${r.message} Their ${moved[0]} moved too.` } : r;
}

export async function setPodAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(fd.get('id') ?? '');
  const podId = String(fd.get('podId') ?? '') || null;
  if (podId && !isAdmin(user) && !user.podIds.includes(podId)) return { ok: false, error: 'Choose one of your pods.' };
  const r = await setContactPod(id, podId, userActor(user), toActor(user));
  refresh(id);
  return r.ok ? { ok: true, message: 'Pod set.' } : r;
}

export async function addNoteAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(fd.get('id') ?? '');
  const r = await addNote(id, String(fd.get('body') ?? ''), user, userActor(user), toActor(user));
  refresh(id);
  return r.ok ? { ok: true, message: 'Note added.' } : r;
}

export async function setNextActionAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(fd.get('id') ?? '');
  const label = String(fd.get('label') ?? '').trim();
  const action = String(fd.get('action') ?? 'EMAIL') as ActionType;
  const dueDate = String(fd.get('dueDate') ?? '');
  if (!label) return { ok: false, error: 'Say what to do.' };
  if (!NEXT_ACTION_CHANNELS.includes(action)) return { ok: false, error: 'Choose how.' };
  if (!isLocalDate(dueDate) || dueDate < todayIn(user.timezone)) return { ok: false, error: 'Pick today or a later day.' };
  const contact = await prisma.sandboxContact.findUnique({ where: { id }, select: { ownerId: true, owner: { select: { active: true } } } });
  // The owner works it; an unclaimed contact (or one whose owner left) is claimed by this write (PLAN 8.1).
  const fo = contact?.ownerId && contact.owner?.active ? contact.ownerId : user.id;
  const r = await setColdNextStep(id, { label, action, dueDate, foUserId: fo }, userActor(user), { guard: toActor(user), act: 'next_step', user });
  refresh(id);
  return r.ok ? { ok: true, message: 'Next step set.' } : { ok: false, error: r.reason };
}

/**
 * Set next step for several contacts from the list (PLAN 4.1), each through the guard and the
 * contactability check on its own, given to its owner as on the contact page.
 */
export async function setNextStepsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = fd.getAll('ids').map(String).filter(Boolean);
  const label = String(fd.get('label') ?? '').trim();
  const action = String(fd.get('action') ?? 'CALL') as ActionType;
  const dueDate = String(fd.get('dueDate') ?? '');
  if (!label) return { ok: false, error: 'Say what to do.' };
  if (!NEXT_ACTION_CHANNELS.includes(action)) return { ok: false, error: 'Choose how.' };
  if (!isLocalDate(dueDate) || dueDate < todayIn(user.timezone)) return { ok: false, error: 'Pick today or a later day.' };
  const owners = new Map((await prisma.sandboxContact.findMany({ where: { id: { in: ids } }, select: { id: true, ownerId: true, owner: { select: { active: true } } } })).map((c) => [c.id, c.ownerId && c.owner?.active ? c.ownerId : user.id]));
  let done = 0;
  const refused: string[] = [];
  for (const id of ids) {
    const r = await setColdNextStep(id, { label, action, dueDate, foUserId: owners.get(id) ?? user.id }, userActor(user), { guard: toActor(user), act: 'next_step', user });
    if (r.ok) done++; else refused.push(r.reason);
  }
  refresh();
  return summary(done, refused, 'Next step set for');
}

/** Opt out: any sales user, any contact, no claim needed (PLAN 8.1); a removed one too (N027). */
export async function optOutContactAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(fd.get('id') ?? '');
  const r = await optOutContact(id, { source: 'contact_page', actor: userActor(user), guard: toActor(user), reason: String(fd.get('reason') ?? '') || null, createdById: user.id });
  refresh(id);
  if (!r.ok) return { ok: false, error: r.reason };
  // N104: reps email from Outlook and dial from their phones, so the words say what to do, not what Cadence does.
  return { ok: true, message: r.changed ? 'Opted out. Do not email, call or message this person. Cadence blocks calls and campaigns. Bellwether shows them as Do not contact.' : 'This contact is already opted out.' };
}

export async function removeContactsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = fd.getAll('ids').map(String).filter(Boolean);
  const reason = String(fd.get('reason') ?? '') || null;
  let done = 0;
  const refused: string[] = [];
  for (const id of ids) {
    const r = await removeContact(id, userActor(user), new Date(), { guard: toActor(user), reason });
    if (r.ok) done++; else refused.push(r.error);
  }
  refresh();
  const r = summary(done, refused, 'Removed');
  return r.ok && ids.length === 1 ? { ...r, redirectTo: COLD_CONTACT_BASE } : r;
}

export async function eraseContactAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await eraseContact(String(fd.get('id') ?? ''), userActor(user), new Date(), toActor(user));
  refresh();
  if (!r.ok) return r;
  return { ok: true, message: r.recordings.length ? `Erased. Delete these recordings in the Twilio console too: ${r.recordings.join(', ')}.` : 'Erased.' };
}

/** Settings > Cold outreach: add an email, phone, LinkedIn URL or individual CRD to the suppression list. */
export async function addSuppressionAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageSettings(toActor(user))) return { ok: false, error: 'Only admins can change the suppression list.' };
  const kind = String(fd.get('kind') ?? '') as SuppressionKind;
  if (!['email', 'phone', 'linkedin', 'individual_crd'].includes(kind)) return { ok: false, error: 'Choose email, phone, LinkedIn or CRD.' };
  const value = normalizedFor(kind, String(fd.get('value') ?? ''));
  if (!value) return { ok: false, error: kind === 'email' ? 'That email address is not valid.' : kind === 'phone' ? 'That phone number could not be read.' : kind === 'individual_crd' ? 'A CRD is digits only.' : 'Enter a LinkedIn profile address.' };
  const r = await suppressValue({ kind, value }, { actor: userActor(user), createdById: user.id });
  revalidatePath('/settings');
  refresh();
  return { ok: true, message: `${r.added ? 'Added' : 'Already on the list'}${r.optedOut ? `; ${r.optedOut} contact${r.optedOut === 1 ? '' : 's'} opted out` : ''}.` };
}

/** N034: a leader gives a removed rep's open next steps to a rep; the CRM ones are written to the CRM again. */
export async function reassignStrandedNextActionsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await reassignStrandedNextActions(String(fd.get('fromUserId') ?? ''), String(fd.get('toUserId') ?? ''), toActor(user), userActor(user));
  if (!r.ok) return r;
  const crm = r.crmIds;
  if (crm.length) await afterResponse(async () => { for (const id of crm) await pushNextAction(id); });
  refresh();
  revalidatePath('/tasks');
  return { ok: true, message: `${r.moved} next step${r.moved === 1 ? '' : 's'} handed on.` };
}

/** N097: a possible bounce checked by the rep: the address is fine (Clear), or it bounced (Confirm). */
export async function clearPossibleBounceAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(fd.get('id') ?? '');
  const r = await clearPossibleBounce(id, toActor(user), userActor(user));
  refresh(id);
  return r;
}

export async function confirmPossibleBounceAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(fd.get('id') ?? '');
  const r = await confirmPossibleBounce(id, toActor(user), userActor(user));
  refresh(id);
  return r;
}
