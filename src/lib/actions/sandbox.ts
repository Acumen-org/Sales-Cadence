'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor, type SessionUser } from '../auth/current-user';
import { canAssignSandbox, canClaimSandbox, canEraseContact, canManageSettings, canRemoveSandboxContact, canWorkSandboxContact, needsPod, isAdmin, whyNotAssignSandbox, whyNotWorkSandboxContact } from '../auth/rbac';
import { userActor } from '../audit';
import { isLocalDate, todayIn } from '../dates';
import { addNote, assignContact, claimContact, createContact, eraseContact, removeContact, setContactPod, updateContact, type ContactInput } from '../sandbox/contacts';
import { optOutSandboxContact, suppressValue } from '../sandbox/opt-out';
import { normalizedFor, type SuppressionKind } from '../sandbox/suppression';
import { setSandboxNextAction } from '../sandbox/work';
import { addToSandboxCampaign, createSandboxCampaign } from '../sandbox/campaigns';
import { NEXT_ACTION_CHANNELS } from '../next-actions';
import type { ActionType } from '@prisma/client';
import type { ActionResult } from './users';

function refresh(id?: string) {
  revalidatePath('/sandbox');
  if (id) revalidatePath(`/sandbox/${id}`);
}

const field = (fd: FormData, k: string) => (fd.has(k) ? String(fd.get(k) ?? '') : undefined);

async function loadForWork(id: string): Promise<{ user: SessionUser; error: string | null; contact: { id: string; ownerId: string | null; podId: string | null } | null }> {
  const user = await requireUser();
  const contact = await prisma.sandboxContact.findUnique({ where: { id }, include: { owner: { select: { name: true } }, pod: { select: { name: true } } } });
  if (!contact) return { user, contact: null, error: 'Contact not found.' };
  if (!canWorkSandboxContact(toActor(user), contact)) return { user, contact: null, error: whyNotWorkSandboxContact(toActor(user), contact.owner?.name ?? null, contact.pod?.name ?? null) };
  return { user, contact, error: null };
}

function contactInput(fd: FormData): Partial<ContactInput> {
  const input: Partial<ContactInput> = {};
  for (const k of ['firstName', 'lastName', 'jobTitle', 'email', 'phone', 'phoneType', 'linkedinUrl', 'city', 'state', 'country', 'companyName', 'companyWebsite', 'companyCrd', 'individualCrd'] as const) {
    const v = field(fd, k);
    if (v !== undefined) (input as Record<string, unknown>)[k] = v;
  }
  if (fd.has('productInterest')) input.productInterest = fd.getAll('productInterest').map(String).filter(Boolean);
  return input;
}

export async function createContactAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!isAdmin(user) && !needsPod(user.role)) return { ok: false, error: 'Biz Ops can view sandbox contacts but cannot add them.' };
  const r = await createContact(contactInput(fd) as ContactInput, { id: user.id, podIds: user.podIds, ownsContacts: needsPod(user.role) || isAdmin(user) }, userActor(user), field(fd, 'podId') || null);
  refresh();
  return r.ok ? { ok: true, message: 'Added to the sandbox.', redirectTo: `/sandbox/${r.id}` } : r;
}

export async function updateContactAction(fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('id') ?? '');
  const { user, contact, error } = await loadForWork(id);
  if (!contact) return { ok: false, error: error! };
  const r = await updateContact(id, contactInput(fd), userActor(user));
  refresh(id);
  return r.ok ? { ok: true, message: 'Saved.' } : r;
}

export async function claimContactsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = fd.getAll('ids').map(String).filter(Boolean);
  let claimed = 0;
  const refused: string[] = [];
  for (const id of ids) {
    const c = await prisma.sandboxContact.findUnique({ where: { id }, select: { ownerId: true, podId: true } });
    if (!c || !canClaimSandbox(toActor(user), c)) { refused.push(id); continue; }
    const r = await claimContact(id, user, userActor(user));
    if (r.ok) claimed++; else refused.push(id);
  }
  refresh(ids.length === 1 ? ids[0] : undefined);
  if (!claimed) return { ok: false, error: ids.length === 1 ? 'This contact already has an owner.' : 'None of these could be claimed: they already have owners.' };
  return { ok: true, message: `Claimed ${claimed}${refused.length ? `; ${refused.length} already had an owner` : ''}.` };
}

export async function assignContactsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = fd.getAll('ids').map(String).filter(Boolean);
  const to = String(fd.get('userId') ?? '') || null;
  let done = 0;
  let refusal: string | null = null;
  for (const id of ids) {
    const c = await prisma.sandboxContact.findUnique({ where: { id }, include: { pod: { select: { name: true } } } });
    if (!c) continue;
    if (!canAssignSandbox(toActor(user), c, to)) { refusal = whyNotAssignSandbox(toActor(user), c.pod?.name ?? null); continue; }
    const r = await assignContact(id, to, userActor(user), field(fd, 'podId') || null);
    if (r.ok) done++; else refusal = r.error;
  }
  refresh(ids.length === 1 ? ids[0] : undefined);
  if (!done) return { ok: false, error: refusal ?? 'Nothing was changed.' };
  return { ok: true, message: to ? `Assigned ${done}.` : `Released ${done}.` };
}

export async function setPodAction(fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('id') ?? '');
  const { user, contact, error } = await loadForWork(id);
  if (!contact) return { ok: false, error: error! };
  const podId = String(fd.get('podId') ?? '') || null;
  if (podId && !isAdmin(user) && !user.podIds.includes(podId)) return { ok: false, error: 'Choose one of your pods.' };
  await setContactPod(id, podId, userActor(user));
  refresh(id);
  return { ok: true, message: 'Pod set.' };
}

export async function addNoteAction(fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('id') ?? '');
  const { user, contact, error } = await loadForWork(id);
  if (!contact) return { ok: false, error: error! };
  const r = await addNote(id, String(fd.get('body') ?? ''), user, userActor(user));
  refresh(id);
  return r.ok ? { ok: true, message: 'Note added.' } : r;
}

export async function setNextActionAction(fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('id') ?? '');
  const { user, contact, error } = await loadForWork(id);
  if (!contact) return { ok: false, error: error! };
  const label = String(fd.get('label') ?? '').trim();
  const action = String(fd.get('action') ?? 'EMAIL') as ActionType;
  const dueDate = String(fd.get('dueDate') ?? '');
  if (!label) return { ok: false, error: 'Say what to do.' };
  if (!NEXT_ACTION_CHANNELS.includes(action)) return { ok: false, error: 'Choose how.' };
  if (!isLocalDate(dueDate) || dueDate < todayIn(user.timezone)) return { ok: false, error: 'Pick today or a later day.' };
  await setSandboxNextAction(id, { label, action, dueDate, foUserId: contact.ownerId ?? user.id }, userActor(user));
  refresh(id);
  return { ok: true, message: 'Next action set.' };
}

export async function optOutContactAction(fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('id') ?? '');
  const { user, contact, error } = await loadForWork(id);
  if (!contact) return { ok: false, error: error! };
  await optOutSandboxContact(id, { source: 'contact_page', actor: userActor(user), reason: String(fd.get('reason') ?? '') || null, createdById: user.id });
  refresh(id);
  return { ok: true, message: 'Opted out. Cadence will not contact this person again, and Bellwether shows them as opted out.' };
}

export async function removeContactsAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = fd.getAll('ids').map(String).filter(Boolean);
  let done = 0;
  for (const id of ids) {
    const c = await prisma.sandboxContact.findUnique({ where: { id }, select: { ownerId: true, podId: true } });
    if (!c || !canRemoveSandboxContact(toActor(user), c)) continue;
    if ((await removeContact(id, userActor(user))).ok) done++;
  }
  refresh();
  return done ? { ok: true, message: `Removed ${done}.`, ...(ids.length === 1 ? { redirectTo: '/sandbox' } : {}) } : { ok: false, error: 'Only the owner, the leaders of its pod and admins can remove these contacts.' };
}

export async function eraseContactAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canEraseContact(toActor(user))) return { ok: false, error: 'Only admins can erase a contact.' };
  const r = await eraseContact(String(fd.get('id') ?? ''), userActor(user));
  refresh();
  if (!r.ok) return r;
  return { ok: true, message: r.recordings.length ? `Erased. Delete these recordings in the Twilio console too: ${r.recordings.join(', ')}.` : 'Erased.' };
}

/** Settings > Sandbox: add an email, phone or LinkedIn URL to the suppression list. */
export async function addSuppressionAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageSettings(toActor(user))) return { ok: false, error: 'Only admins can change the suppression list.' };
  const kind = String(fd.get('kind') ?? '') as SuppressionKind;
  if (!['email', 'phone', 'linkedin'].includes(kind)) return { ok: false, error: 'Choose email, phone or LinkedIn.' };
  const value = normalizedFor(kind, String(fd.get('value') ?? ''));
  if (!value) return { ok: false, error: kind === 'email' ? 'That email address is not valid.' : kind === 'phone' ? 'That phone number could not be read.' : 'Enter a LinkedIn profile address.' };
  const r = await suppressValue({ kind, value }, { actor: userActor(user), createdById: user.id });
  revalidatePath('/settings');
  refresh();
  return { ok: true, message: `${r.added ? 'Added' : 'Already on the list'}${r.optedOut ? `; ${r.optedOut} contact${r.optedOut === 1 ? '' : 's'} opted out` : ''}.` };
}

export async function startSandboxCampaignAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await createSandboxCampaign({ name: String(fd.get('name') ?? ''), sequenceId: String(fd.get('sequenceId') ?? ''), podId: String(fd.get('podId') ?? ''), startDate: String(fd.get('startDate') ?? ''), contactIds: fd.getAll('ids').map(String).filter(Boolean), startsPerFoPerDay: fd.get('pace') ? Number(fd.get('pace')) : null }, toActor(user), userActor(user));
  refresh();
  if (!r.ok) return r;
  // A campaign that starts today starts now, as an approved CRM campaign would.
  const { activateCampaign } = await import('../engine/campaigns');
  await activateCampaign(r.id, { actor: userActor(user) }).catch(() => undefined);
  return { ok: true, message: r.left ? `Campaign created. Left out: ${r.left}.` : 'Campaign created.', redirectTo: `/sandbox/campaigns/${r.id}` };
}

export async function addToSandboxCampaignAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const campaignId = String(fd.get('campaignId') ?? '');
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { podId: true, createdById: true } });
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  if (!isAdmin(user) && !user.podIds.includes(campaign.podId)) return { ok: false, error: 'You can add contacts only to campaigns of your pods.' };
  const r = await addToSandboxCampaign(campaignId, fd.getAll('ids').map(String).filter(Boolean), userActor(user));
  refresh();
  if (!r.ok) return r;
  return { ok: true, message: `Added ${r.added}.${r.left ? ` Left out: ${r.left}.` : ''}` };
}
