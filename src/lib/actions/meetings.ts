'use server';

import { revalidatePath } from 'next/cache';
import { optionLabel } from '../twenty/labels';
import { PRODUCTS, type Product } from '../workspace';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireUser, toActor, type SessionUser } from '../auth/current-user';
import { isAdmin, isPodLeader } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { getSettings, isExternalEmail } from '../settings';
import { parseMeetingLink } from '../meetings/providers';
import { detectTranscriptFormat, parseTranscript } from '../meetings/transcript';
import { getMeetingAnalyzer, MeetingAnalysisSchema } from '../meetings/analysis';
import { localDateTimeToInstant } from '../dates';
import type { ActionResult } from './users';

export type AttendeeSelection = { personId?: string | null; userId?: string | null; name: string | null; email: string | null };
export type AttendeeOption = AttendeeSelection & { key: string; kind: 'contact' | 'team'; detail: string | null };

async function mayManageMeeting(user: SessionUser, meeting: { id: string; createdById: string | null; companyId: string | null }): Promise<boolean> {
  if (meeting.createdById === user.id || isAdmin(toActor(user))) return true;
  if (!isPodLeader(toActor(user)) || !user.podIds.length) return false;
  const [pods, linkedContacts] = await Promise.all([
    prisma.pod.findMany({ where: { id: { in: user.podIds }, archived: false }, select: { podOwnerValue: true } }),
    prisma.meetingAttendee.count({ where: { meetingId: meeting.id, personId: { not: null } } }),
  ]);
  const count = await prisma.personCache.count({ where: {
    deletedAt: null,
    OR: [{ meetingAttendees: { some: { meetingId: meeting.id } } }, ...(!linkedContacts && meeting.companyId ? [{ companyId: meeting.companyId }] : [])],
    AND: [{ OR: [{ podOwner: { in: pods.map((p) => p.podOwnerValue) } }, { enrollments: { some: { podId: { in: user.podIds } } } }] }],
  } });
  return count > 0;
}

export async function canManageMeetingAction(meetingId: string): Promise<boolean> {
  const user = await requireUser();
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { id: true, createdById: true, companyId: true } });
  return meeting ? mayManageMeeting(user, meeting) : false;
}

/**
 * Tag or untag one product on an open meeting.
 *
 * Separate from the edit form on purpose: tagging is something you do while reading the notes,
 * and sending someone through a full form - which also re-parses the transcript and clears any
 * analysis - to add "Glynac" would be absurd.
 */
export async function toggleMeetingProductAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const product = String(formData.get('product') ?? '');
  if (!(PRODUCTS as readonly string[]).includes(product)) return { ok: false, error: 'Unknown product.' };
  const meeting = await prisma.meeting.findUnique({ where: { id }, select: { id: true, createdById: true, companyId: true, products: true } });
  if (!meeting) return { ok: false, error: 'Meeting not found.' };
  if (!(await mayManageMeeting(user, meeting))) return { ok: false, error: 'You do not have permission to edit this meeting.' };

  // The caller says what it wants, not "flip it": two tabs open on the same meeting must not be
  // able to ask for opposite things and both be told they succeeded.
  const want = String(formData.get('on') ?? '') === 'true';
  const products = want ? [...meeting.products, product] : meeting.products.filter((p) => p !== product);
  // Stored in the order the list defines, so two meetings with the same tags read the same.
  const ordered = PRODUCTS.filter((p) => products.includes(p));
  await prisma.meeting.update({ where: { id }, data: { products: ordered } });
  if (want !== meeting.products.includes(product)) {
    await logAudit({ entityType: 'meeting', entityId: id, action: want ? 'product_added' : 'product_removed', actor: userActor(user), details: { product } });
  }
  revalidatePath(`/meetings/${id}`);
  revalidatePath('/meetings');
  if (meeting.companyId) revalidatePath(`/accounts/${meeting.companyId}`);
  return { ok: true, message: want ? `${optionLabel(product)} added.` : `${optionLabel(product)} removed.`, data: { products: ordered } };
}

const AttendeeSchema = z.object({
  personId: z.string().trim().min(1).max(200).nullable().optional(),
  userId: z.string().trim().min(1).max(200).nullable().optional(),
  name: z.string().trim().max(200).nullable(),
  email: z.string().trim().email().max(254).nullable(),
}).refine((a) => Boolean(a.personId || a.userId || a.name || a.email), 'Choose a person or enter a name.');

export async function searchMeetingAttendeesAction(query: string): Promise<AttendeeOption[]> {
  await requireUser();
  const q = query.trim().slice(0, 120);
  const [people, users] = await Promise.all([
    prisma.personCache.findMany({ where: { deletedAt: null, ...(q ? { OR: [{ firstName: { contains: q, mode: 'insensitive' as const } }, { lastName: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }, { companyName: { contains: q, mode: 'insensitive' as const } }] } : {}) }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }], take: 20, select: { id: true, firstName: true, lastName: true, email: true, companyName: true } }),
    prisma.user.findMany({ where: { active: true, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }] } : {}) }, orderBy: { name: 'asc' }, take: 20, select: { id: true, name: true, email: true } }),
  ]);
  return [...users.map((u): AttendeeOption => ({ key: `user:${u.id}`, userId: u.id, name: u.name, email: u.email, kind: 'team', detail: 'Your team' })), ...people.map((p): AttendeeOption => ({ key: `person:${p.id}`, personId: p.id, name: `${p.firstName} ${p.lastName}`.trim() || p.email, email: p.email, kind: 'contact', detail: p.companyName }))];
}

function attendeeEntries(formData: FormData): AttendeeSelection[] {
  const json = formData.get('attendeesJson');
  const raw = typeof json === 'string' ? JSON.parse(json) : parseAttendees(String(formData.get('attendees') ?? ''));
  const parsed = z.array(AttendeeSchema).max(200).safeParse(raw);
  if (!parsed.success) throw new Error('Choose valid attendees; use a valid email address for guests. Maximum 200 attendees.');
  return parsed.data;
}

/** "Name <a@b.com>", "a@b.com", or a bare name; one per line or comma separated. */
function parseAttendees(raw: string): Array<{ name: string | null; email: string | null }> {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const angle = /^(.*?)<([^>]+)>$/.exec(entry);
      if (angle) return { name: angle[1].trim() || null, email: angle[2].trim().toLowerCase() };
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry)) return { name: null, email: entry.toLowerCase() };
      return { name: entry, email: null };
    })
    .filter((a, i, arr) => (a.email ? arr.findIndex((x) => x.email === a.email) === i : true));
}

const MeetingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceUrl: z.string().trim().max(8192).url().refine((url) => /^https?:\/\//i.test(url), 'Use an http or https recording link.'),
  occurredAt: z.string().trim().min(1),
  durationSec: z.coerce.number().int().min(0).max(86_400).optional().nullable(),
  companyId: z.string().trim().optional().nullable(),
  // A meeting can be about more than one product, so unknown values are dropped rather than
  // rejected: the list is ours, and a stale form should not lose the rest of the edit.
  products: z.array(z.string()).default([]).transform((v) => v.filter((p): p is Product => (PRODUCTS as readonly string[]).includes(p))),
  attendees: z.string().optional().default(''),
  transcript: z.string().max(2_000_000).optional().nullable(),
});

function readForm(formData: FormData) {
  return MeetingSchema.safeParse({
    title: formData.get('title'),
    sourceUrl: formData.get('sourceUrl'),
    occurredAt: formData.get('occurredAt'),
    durationSec: formData.get('durationMin') ? Number(formData.get('durationMin')) * 60 : null,
    companyId: formData.get('companyId') || null,
    products: formData.getAll('products').map(String),
    attendees: formData.get('attendees') ?? '',
    transcript: formData.get('transcript') || null,
  });
}

/** Match attendees to Twenty people and Cadence users, and mark who is external. */
async function resolveAttendees(entries: AttendeeSelection[], hostUserId: string | null) {
  const settings = await getSettings();
  const emails = entries.map((e) => e.email).filter((e): e is string => Boolean(e));
  const [people, users] = await Promise.all([
    prisma.personCache.findMany({ where: { deletedAt: null, OR: [{ id: { in: entries.flatMap((e) => e.personId ? [e.personId] : []) } }, { email: { in: emails, mode: 'insensitive' } }] }, select: { id: true, email: true, firstName: true, lastName: true } }),
    // A colleague's mailbox address is often not their Cadence login, so aliases count too.
    prisma.user.findMany({ where: { OR: [{ id: { in: entries.flatMap((e) => e.userId ? [e.userId] : []) } }, { email: { in: emails, mode: 'insensitive' } }, { aliases: { hasSome: emails } }] }, select: { id: true, email: true, name: true, aliases: true } }),
  ]);
  const personByEmail = new Map(people.map((p) => [p.email?.toLowerCase(), p]));
  const userByEmail = new Map<string, { id: string; name: string }>();
  for (const u of users) {
    for (const key of [u.email, ...u.aliases]) {
      const k = key.toLowerCase();
      if (k.includes('@') && !userByEmail.has(k)) userByEmail.set(k, { id: u.id, name: u.name });
    }
  }
  const seen = new Set<string>();
  return entries.map((e) => {
    const key = e.email?.toLowerCase();
    const person = e.personId ? people.find((p) => p.id === e.personId) : key ? personByEmail.get(key) : undefined;
    const user = e.userId ? users.find((u) => u.id === e.userId) : key ? userByEmail.get(key) : undefined;
    if (e.personId && !person) throw new Error('A selected contact no longer exists. Remove them and try again.');
    if (e.userId && !user) throw new Error('A selected team member no longer exists. Remove them and try again.');
    const canonicalUser = user ? users.find((u) => u.id === user.id) : undefined;
    const email = canonicalUser ? canonicalUser.email : person ? person.email : e.email?.toLowerCase() ?? null;
    return {
      name: user?.name ?? (person ? `${person.firstName} ${person.lastName}`.trim() : e.name),
      email,
      personId: person?.id ?? null,
      userId: user?.id ?? null,
      external: user ? false : person ? true : isExternalEmail(email, settings.rules.internalDomains),
      host: Boolean(user && user.id === hostUserId),
    };
  }).filter((entry) => {
    const keys = [entry.userId ? `user:${entry.userId}` : null, entry.personId ? `person:${entry.personId}` : null, entry.email ? `email:${entry.email.toLowerCase()}` : null].filter((key): key is string => Boolean(key));
    if (!keys.length) keys.push(`name:${entry.name?.toLowerCase()}`);
    if (keys.some((key) => seen.has(key))) return false;
    keys.forEach((key) => seen.add(key));
    return true;
  });
}

export async function createMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = readForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const d = parsed.data;
  const occurredAt = localDateTimeToInstant(d.occurredAt, user.timezone);
  if (!occurredAt) return { ok: false, error: `Pick a valid date and time in ${user.timezone}.` };
  const link = parseMeetingLink(d.sourceUrl);
  if (link.provider === 'OTHER' && link.note?.includes('does not look like a URL')) return { ok: false, error: link.note };

  const company = d.companyId ? await prisma.companyCache.findFirst({ where: { id: d.companyId, deletedAt: null }, select: { id: true, name: true } }) : null;
  if (d.companyId && !company) return { ok: false, error: 'The selected account no longer exists.' };
  let attendees: Awaited<ReturnType<typeof resolveAttendees>>;
  try { attendees = await resolveAttendees(attendeeEntries(formData), user.id); }
  catch (error) { return { ok: false, error: error instanceof SyntaxError ? 'The attendee list is invalid.' : error instanceof Error ? error.message : 'Unable to resolve attendees.' }; }
  const transcript = d.transcript?.trim() || null;

  const meeting = await prisma.meeting.create({
    data: {
      title: d.title,
      provider: link.provider,
      sourceUrl: d.sourceUrl.trim(),
      embedUrl: link.embedUrl,
      mediaUrl: link.mediaUrl,
      occurredAt,
      durationSec: d.durationSec ?? null,
      companyId: company?.id ?? null,
      companyName: company?.name ?? null,
      products: d.products,
      transcript,
      transcriptFormat: transcript ? detectTranscriptFormat(transcript) : null,
      createdById: user.id,
      attendees: { create: attendees },
    },
  });
  await logAudit({ entityType: 'meeting', entityId: meeting.id, action: 'created', actor: userActor(user), details: { title: meeting.title, provider: meeting.provider, attendees: attendees.length } });
  revalidatePath('/meetings');
  revalidatePath('/home');
  if (company?.id) revalidatePath(`/accounts/${company.id}`);
  return { ok: true, message: 'Meeting added.', redirectTo: `/meetings/${meeting.id}` };
}

export async function updateMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const existing = await prisma.meeting.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: 'Meeting not found.' };
  if (!(await mayManageMeeting(user, existing))) return { ok: false, error: 'You do not have permission to edit this meeting.' };
  const parsed = readForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const d = parsed.data;
  const occurredAt = localDateTimeToInstant(d.occurredAt, user.timezone);
  if (!occurredAt) return { ok: false, error: `Pick a valid date and time in ${user.timezone}.` };
  const link = parseMeetingLink(d.sourceUrl);
  const company = d.companyId ? await prisma.companyCache.findFirst({ where: { id: d.companyId, deletedAt: null }, select: { id: true, name: true } }) : null;
  if (d.companyId && !company) return { ok: false, error: 'The selected account no longer exists.' };
  let attendees: Awaited<ReturnType<typeof resolveAttendees>>;
  try { attendees = await resolveAttendees(attendeeEntries(formData), existing.createdById); }
  catch (error) { return { ok: false, error: error instanceof SyntaxError ? 'The attendee list is invalid.' : error instanceof Error ? error.message : 'Unable to resolve attendees.' }; }
  const transcript = d.transcript?.trim() || null;

  await prisma.$transaction(async (tx) => {
    await tx.meetingAttendee.deleteMany({ where: { meetingId: id } });
    await tx.meeting.update({
      where: { id },
      data: {
        title: d.title,
        provider: link.provider,
        sourceUrl: d.sourceUrl.trim(),
        embedUrl: link.embedUrl,
        mediaUrl: link.mediaUrl,
        occurredAt,
        durationSec: d.durationSec ?? null,
        companyId: company?.id ?? null,
        companyName: company?.name ?? null,
        products: d.products,
        transcript,
        transcriptFormat: transcript ? detectTranscriptFormat(transcript) : null,
        // A changed transcript invalidates any analysis.
        analysis: Prisma.DbNull, analysisStatus: 'NONE', analysedAt: null, analysisModel: null, analysisError: null,
        attendees: { create: attendees },
      },
    });
  });
  await logAudit({ entityType: 'meeting', entityId: id, action: 'updated', actor: userActor(user) });
  revalidatePath('/meetings');
  revalidatePath(`/meetings/${id}`);
  revalidatePath('/accounts');
  if (existing.companyId) revalidatePath(`/accounts/${existing.companyId}`);
  if (company?.id) revalidatePath(`/accounts/${company.id}`);
  return { ok: true, message: 'Saved.' };
}

export async function updateMeetingAttendeesAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const meeting = await prisma.meeting.findUnique({ where: { id }, select: { id: true, createdById: true, companyId: true } });
  if (!meeting) return { ok: false, error: 'Meeting not found.' };
  if (!(await mayManageMeeting(user, meeting))) return { ok: false, error: 'You do not have permission to edit attendees for this meeting.' };
  let attendees: Awaited<ReturnType<typeof resolveAttendees>>;
  try { attendees = await resolveAttendees(attendeeEntries(formData), meeting.createdById); }
  catch (error) { return { ok: false, error: error instanceof SyntaxError ? 'The attendee list is invalid.' : error instanceof Error ? error.message : 'Unable to resolve attendees.' }; }
  await prisma.$transaction(async (tx) => {
    await tx.meetingAttendee.deleteMany({ where: { meetingId: id } });
    await tx.meeting.update({ where: { id }, data: { attendees: { create: attendees }, analysis: Prisma.DbNull, analysisStatus: 'NONE', analysedAt: null, analysisModel: null, analysisError: null } });
  });
  await logAudit({ entityType: 'meeting', entityId: id, action: 'attendees_updated', actor: userActor(user), details: { attendees: attendees.length } });
  revalidatePath(`/meetings/${id}`);
  revalidatePath('/meetings');
  revalidatePath('/reports');
  if (meeting.companyId) revalidatePath(`/accounts/${meeting.companyId}`);
  return { ok: true, message: 'Attendees updated.' };
}

export async function deleteMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const existing = await prisma.meeting.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: 'Meeting not found.' };
  if (!(await mayManageMeeting(user, existing))) return { ok: false, error: 'You do not have permission to delete this meeting.' };
  await prisma.meeting.delete({ where: { id } });
  await logAudit({ entityType: 'meeting', entityId: id, action: 'deleted', actor: userActor(user), details: { title: existing.title } });
  revalidatePath('/meetings');
  revalidatePath('/accounts');
  if (existing.companyId) revalidatePath(`/accounts/${existing.companyId}`);
  return { ok: true, message: 'Meeting deleted.', redirectTo: '/meetings' };
}

/**
 * Run the configured analyzer. Today that is the local transcript-stats analyzer; when a model is
 * connected this same action drives it. Kept explicit (a button) rather than automatic so a slow
 * or costly model is never triggered by page loads.
 */
export async function analyseMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const meeting = await prisma.meeting.findUnique({ where: { id }, include: { attendees: true } });
  if (!meeting) return { ok: false, error: 'Meeting not found.' };

  if (!(await mayManageMeeting(user, meeting))) return { ok: false, error: 'You do not have permission to analyse this meeting.' };
  const analyzer = getMeetingAnalyzer();
  const input = {
    meetingId: meeting.id,
    title: meeting.title,
    occurredAt: meeting.occurredAt,
    transcript: meeting.transcript,
    attendees: meeting.attendees.map((a) => ({ name: a.name, email: a.email, external: a.external, host: a.host })),
    companyName: meeting.companyName,
  };
  if (!analyzer.canAnalyze(input)) {
    return { ok: false, error: 'Nothing to analyse yet: add a transcript first. A language model is not connected, so only transcript statistics can be produced.' };
  }
  await prisma.meeting.update({ where: { id }, data: { analysisStatus: 'PENDING', analysisError: null } });
  try {
    const analysis = MeetingAnalysisSchema.parse(await analyzer.analyze(input));
    await prisma.meeting.update({
      where: { id },
      data: { analysis, analysisStatus: 'READY', analysisModel: analyzer.name, analysedAt: new Date(), analysisError: null },
    });
    await logAudit({ entityType: 'meeting', entityId: id, action: 'analysed', actor: userActor(user), details: { model: analyzer.name } });
    revalidatePath(`/meetings/${id}`);
    return { ok: true, message: `Analysed with ${analyzer.name}.` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.meeting.update({ where: { id }, data: { analysisStatus: 'FAILED', analysisError: message } });
    revalidatePath(`/meetings/${id}`);
    return { ok: false, error: `Analysis failed: ${message}` };
  }
}

/** Paste or replace a transcript on its own, without touching the rest of the meeting. */
export async function saveTranscriptAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const raw = String(formData.get('transcript') ?? '').trim();
  if (raw.length > 2_000_000) return { ok: false, error: 'The transcript is too long (maximum 2 million characters).' };
  const meeting = await prisma.meeting.findUnique({ where: { id }, select: { id: true, createdById: true, companyId: true } });
  if (!meeting) return { ok: false, error: 'Meeting not found.' };
  if (!(await mayManageMeeting(user, meeting))) return { ok: false, error: 'You do not have permission to edit this meeting.' };
  const format = raw ? detectTranscriptFormat(raw) : null;
  const cues = raw ? parseTranscript(raw, format ?? undefined).cues.length : 0;
  await prisma.meeting.update({
    where: { id },
    data: { transcript: raw || null, transcriptFormat: format, analysis: Prisma.DbNull, analysisStatus: 'NONE', analysedAt: null, analysisModel: null, analysisError: null },
  });
  await logAudit({ entityType: 'meeting', entityId: id, action: 'transcript_saved', actor: userActor(user), details: { format, cues } });
  revalidatePath(`/meetings/${id}`);
  return { ok: true, message: raw ? `Transcript saved (${format}, ${cues} segments).` : 'Transcript cleared.' };
}
