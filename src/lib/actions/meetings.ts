'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { isAdmin } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { getSettings, isExternalEmail } from '../settings';
import { parseMeetingLink } from '../meetings/providers';
import { detectTranscriptFormat, parseTranscript } from '../meetings/transcript';
import { getMeetingAnalyzer, MeetingAnalysisSchema } from '../meetings/analysis';
import type { ActionResult } from './users';


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
  sourceUrl: z.string().trim().min(1),
  occurredAt: z.string().trim().min(1),
  durationSec: z.coerce.number().int().min(0).max(86_400).optional().nullable(),
  companyId: z.string().trim().optional().nullable(),
  attendees: z.string().optional().default(''),
  notes: z.string().trim().max(4000).optional().nullable(),
  transcript: z.string().max(2_000_000).optional().nullable(),
});

function readForm(formData: FormData) {
  return MeetingSchema.safeParse({
    title: formData.get('title'),
    sourceUrl: formData.get('sourceUrl'),
    occurredAt: formData.get('occurredAt'),
    durationSec: formData.get('durationMin') ? Number(formData.get('durationMin')) * 60 : null,
    companyId: formData.get('companyId') || null,
    attendees: formData.get('attendees') ?? '',
    notes: formData.get('notes') || null,
    transcript: formData.get('transcript') || null,
  });
}

/** Match attendees to Twenty people and Cadence users, and mark who is external. */
async function resolveAttendees(entries: Array<{ name: string | null; email: string | null }>, hostEmail: string | null) {
  const settings = await getSettings();
  const emails = entries.map((e) => e.email).filter((e): e is string => Boolean(e));
  const [people, users] = await Promise.all([
    emails.length ? prisma.personCache.findMany({ where: { email: { in: emails, mode: 'insensitive' } }, select: { id: true, email: true, firstName: true, lastName: true } }) : Promise.resolve([]),
    // A colleague's mailbox address is often not their Cadence login, so aliases count too.
    emails.length
      ? prisma.user.findMany({ where: { OR: [{ email: { in: emails, mode: 'insensitive' } }, { aliases: { hasSome: emails } }] }, select: { id: true, email: true, name: true, aliases: true } })
      : Promise.resolve([]),
  ]);
  const personByEmail = new Map(people.map((p) => [p.email?.toLowerCase(), p]));
  const userByEmail = new Map<string, { id: string; name: string }>();
  for (const u of users) {
    for (const key of [u.email, ...u.aliases]) {
      const k = key.toLowerCase();
      if (k.includes('@') && !userByEmail.has(k)) userByEmail.set(k, { id: u.id, name: u.name });
    }
  }
  return entries.map((e) => {
    const key = e.email?.toLowerCase();
    const person = key ? personByEmail.get(key) : undefined;
    const user = key ? userByEmail.get(key) : undefined;
    return {
      name: e.name ?? (person ? `${person.firstName} ${person.lastName}`.trim() : user?.name ?? null),
      email: e.email,
      personId: person?.id ?? null,
      userId: user?.id ?? null,
      external: isExternalEmail(e.email, settings.rules.internalDomains),
      host: Boolean(hostEmail && key === hostEmail.toLowerCase()),
    };
  });
}

export async function createMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = readForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const d = parsed.data;
  const occurredAt = new Date(d.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return { ok: false, error: 'Pick a valid date and time.' };
  const link = parseMeetingLink(d.sourceUrl);
  if (link.provider === 'OTHER' && link.note?.includes('does not look like a URL')) return { ok: false, error: link.note };

  const company = d.companyId ? await prisma.companyCache.findUnique({ where: { id: d.companyId }, select: { id: true, name: true } }) : null;
  const attendees = await resolveAttendees(parseAttendees(d.attendees ?? ''), user.email);
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
      notes: d.notes ?? null,
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
  if (existing.createdById !== user.id && !isAdmin(toActor(user))) return { ok: false, error: 'Only the person who added this meeting, or an admin, can change it.' };
  const parsed = readForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const d = parsed.data;
  const occurredAt = new Date(d.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return { ok: false, error: 'Pick a valid date and time.' };
  const link = parseMeetingLink(d.sourceUrl);
  const company = d.companyId ? await prisma.companyCache.findUnique({ where: { id: d.companyId }, select: { id: true, name: true } }) : null;
  const attendees = await resolveAttendees(parseAttendees(d.attendees ?? ''), user.email);
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
        notes: d.notes ?? null,
        transcript,
        transcriptFormat: transcript ? detectTranscriptFormat(transcript) : null,
        // A changed transcript invalidates any analysis.
        ...(transcript !== existing.transcript ? { analysis: Prisma.DbNull, analysisStatus: 'NONE' as const, analysedAt: null, analysisModel: null, analysisError: null } : {}),
        attendees: { create: attendees },
      },
    });
  });
  await logAudit({ entityType: 'meeting', entityId: id, action: 'updated', actor: userActor(user) });
  revalidatePath('/meetings');
  revalidatePath(`/meetings/${id}`);
  return { ok: true, message: 'Saved.' };
}

export async function deleteMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const existing = await prisma.meeting.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: 'Meeting not found.' };
  if (existing.createdById !== user.id && !isAdmin(toActor(user))) return { ok: false, error: 'Only the person who added this meeting, or an admin, can delete it.' };
  await prisma.meeting.delete({ where: { id } });
  await logAudit({ entityType: 'meeting', entityId: id, action: 'deleted', actor: userActor(user), details: { title: existing.title } });
  revalidatePath('/meetings');
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
  const meeting = await prisma.meeting.findUnique({ where: { id }, select: { id: true, createdById: true } });
  if (!meeting) return { ok: false, error: 'Meeting not found.' };
  if (meeting.createdById !== user.id && !isAdmin(toActor(user))) return { ok: false, error: 'Only the person who added this meeting, or an admin, can change it.' };
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
