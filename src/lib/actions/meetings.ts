'use server';

import { revalidatePath } from 'next/cache';
import { optionLabel } from '../twenty/labels';
import { PRODUCTS } from '../workspace';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireUser, toActor, type SessionUser } from '../auth/current-user';
import { isAdmin, isPodLeader, canApproveMeeting, canCreateMeeting, ROLES_NEEDING_POD, whyNotManageMeeting } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { inspectLink } from '../meetings/resolve-media';
import { resolveAttendees, type AttendeeSelection } from '../meetings/attendees';
import { findProspects, findTeam, type ProspectOption, type TeamOption } from '../meetings/people-search';
import { renumberProspects, upcomingNumbers, type ProspectNumber } from '../meetings/numbering';
import { meetingCompany } from '../meetings/account';
import { fetchMeetingTranscript, transcriptForRecording, mayReadTranscripts } from '../meetings/teams-transcript';
import { linkKey, linkNeedle } from '../meetings/link-key';
import { pushMeetingToCrm, removeMeetingFromCrm } from '../meetings/crm';
import { afterResponse } from '../engine/sync-out';
import { extractRecordingUrl, parseMeetingLink } from '../meetings/providers';
import { sharePointPlayer, sharePointRecording, needsPlayer } from '../meetings/sharepoint-player';
import { libraryFieldsFor } from '../meetings/library';
import { approvalForSave, askForApproval, bookerPodIds, declinedTwin, settleApprovalAsks } from '../meetings/approval';
import { detectTranscriptFormat, parseTranscript } from '../meetings/transcript';
import { getMeetingAnalyzer, MeetingAnalysisSchema } from '../meetings/analysis';
import { meetingDay, meetingDayInstant, parseMeetingDay } from '../meetings/day';
import { transcriptKey } from '../meetings/transcript-key';
import type { ActionResult } from './users';
import { issueText } from '../form-errors';
import { externalPeopleWhere } from '../internal-organizations';

export type { AttendeeSelection, ProspectOption, TeamOption, ProspectNumber };

async function mayManageMeeting(user: SessionUser, meeting: { id: string; createdById: string | null; companyId: string | null }): Promise<boolean> {
  if (!canCreateMeeting(user)) return false;
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
  if (!(await mayManageMeeting(user, meeting))) return { ok: false, error: whyNotManageMeeting(toActor(user), 'edit this meeting') };

  // The caller says what it wants, not "flip it": two tabs open on the same meeting must not be
  // able to ask for opposite things and both be told they succeeded.
  const want = String(formData.get('on') ?? '') === 'true';
  // S19: saved only over the list it was read from; a tag someone else set meanwhile is read again, not dropped.
  let current = meeting.products;
  let ordered: string[] = current;
  for (let attempt = 0; ; attempt++) {
    const products = want ? [...current, product] : current.filter((p) => p !== product);
    if (!products.length) return { ok: false, error: `${optionLabel(product)} is the only product on this meeting, and a meeting needs one. Add the right product first, then remove ${optionLabel(product)}.` };
    // Stored in the order the list defines, so two meetings with the same tags read the same.
    ordered = PRODUCTS.filter((p) => products.includes(p));
    if ((await prisma.meeting.updateMany({ where: { id, products: { equals: current } }, data: { products: ordered } })).count) break;
    const again = await prisma.meeting.findUnique({ where: { id }, select: { products: true } });
    if (!again || attempt >= 4) return { ok: false, error: 'Someone else changed this meeting’s products at the same moment. Try again.' };
    current = again.products;
  }
  if (want !== current.includes(product)) {
    await logAudit({ entityType: 'meeting', entityId: id, action: want ? 'product_added' : 'product_removed', actor: userActor(user), details: { product } });
    await afterResponse(() => pushMeetingToCrm(id));
  }
  revalidatePath(`/meetings/${id}`);
  revalidatePath('/meetings');
  if (meeting.companyId) revalidatePath(`/accounts/${meeting.companyId}`);
  return { ok: true, message: want ? `${optionLabel(product)} added.` : `${optionLabel(product)} removed.`, data: { products: ordered } };
}

/** Prospects: anyone in Twenty, by a few letters of their name, their address or their company. */
export async function searchProspectsAction(query: string): Promise<ProspectOption[]> {
  await requireUser();
  return findProspects(String(query ?? ''));
}

/** Our own team, for who was on the call. */
export async function searchTeamAction(query: string): Promise<TeamOption[]> {
  await requireUser();
  return findTeam(String(query ?? ''));
}

/** Which meeting with each prospect this one will be, counting itself, for the form to show. */
export async function prospectNumbersAction(personIds: string[], day: string, meetingId: string | null): Promise<ProspectNumber[]> {
  await requireUser();
  const ids = z.array(z.string().trim().min(1).max(200)).max(100).safeParse(personIds);
  return ids.success ? upcomingNumbers(ids.data, String(day ?? ''), meetingId || null) : [];
}

const IdList = z.array(z.string().trim().min(1).max(200)).max(200);

/** The ids a picker sends as JSON; anything malformed reads as none, which the form then asks for. */
function idList(formData: FormData, field: string): string[] {
  try {
    const parsed = IdList.safeParse(JSON.parse(String(formData.get(field) ?? '[]')));
    return parsed.success ? [...new Set(parsed.data)] : [];
  } catch {
    return [];
  }
}

type Attendee = Awaited<ReturnType<typeof resolveAttendees>>[number] & { prospect: boolean };

/**
 * Who was there, as the form gives it: the team on the call and the prospects, both required.
 * Anyone else already on the meeting (a guest typed in before the form had these two lists) stays.
 */
async function meetingPeople(formData: FormData, hostUserId: string | null, keep: AttendeeSelection[] = []): Promise<{ attendees: Attendee[]; prospectIds: string[] } | { error: string }> {
  const teamIds = idList(formData, 'teamJson');
  const prospectIds = idList(formData, 'prospectsJson');
  if (!teamIds.length) return { error: 'Choose who from the team was on the call.' };
  if (!prospectIds.length) return { error: 'Choose the prospects the meeting was with.' };
  const [users, people, outside] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: teamIds }, active: true }, select: { id: true } }),
    prisma.personCache.findMany({ where: { id: { in: prospectIds }, deletedAt: null }, select: { id: true } }),
    // S13: a prospect is someone outside the team, as the picker offers them, not any CRM record.
    externalPeopleWhere({ keepBlocked: true }).then(async (notTeam) => prisma.personCache.count({ where: { AND: [{ id: { in: prospectIds }, deletedAt: null }, notTeam] } })),
  ]);
  if (users.length !== teamIds.length) return { error: 'Someone chosen from the team no longer has access to Cadence. Remove them and try again.' };
  if (people.length !== prospectIds.length) return { error: 'A prospect chosen is no longer in the CRM. Remove them and try again.' };
  if (outside !== prospectIds.length) return { error: 'A prospect chosen is on our team or at one of our own companies. Choose the people the meeting was with.' };
  let resolved: Awaited<ReturnType<typeof resolveAttendees>>;
  try {
    resolved = await resolveAttendees([
      ...teamIds.map((userId) => ({ userId, name: null, email: null })),
      ...prospectIds.map((personId) => ({ personId, name: null, email: null })),
      ...keep,
    ], hostUserId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unable to resolve who was there.' };
  }
  const attendees = resolved.map((a) => ({ ...a, prospect: Boolean(a.personId && !a.userId && prospectIds.includes(a.personId)) }));
  const prospects = attendees.filter((a) => a.prospect).map((a) => a.personId!);
  if (!prospects.length) return { error: 'Everyone chosen as a prospect is on our team. Choose the people the meeting was with.' };
  return { attendees, prospectIds: prospects };
}

/**
 * After a meeting's prospects, date or existence change: number again everyone it touched, and
 * write to Twenty this meeting and every other one whose numbers moved. A SharePoint recording
 * without a transcript gets its Teams transcript first, so Twenty hears about that too.
 */
async function afterMeetingChange(meetingId: string | null, personIds: Iterable<string>, fetchTranscript = false, by: { id: string; name?: string | null } | null = null) {
  const changed = await renumberProspects(personIds);
  await afterResponse(async () => {
    if (meetingId && fetchTranscript) await fetchMeetingTranscript(meetingId, by).catch(() => false);
    for (const id of new Set([...(meetingId ? [meetingId] : []), ...changed])) await pushMeetingToCrm(id);
  });
}

const MeetingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  // A pasted embed code is reduced to its src before validation, so Share > Embed works as pasted.
  sourceUrl: z.preprocess((v) => (typeof v === 'string' && v.trim() ? extractRecordingUrl(v) : ''), z.string().trim().max(8192).refine((url) => url === '' || /^https?:\/\/\S+$/i.test(url), 'Use an http or https recording link, or leave it blank.')),
  bookedById: z.string().trim().min(1, 'Choose who booked the meeting.'),
  occurredAt: z.string().trim().min(1),
  // A meeting can be about more than one product, so unknown values are dropped rather than
  // rejected: the list is ours, and a stale form should not lose the rest of the edit. At least
  // one is required (owner, 29 October 2026).
  products: z.array(z.string()).default([]).transform((v) => PRODUCTS.filter((p) => v.includes(p))).refine((v) => v.length > 0, 'Choose the products the meeting was about.'),
  transcript: z.string().max(2_000_000).optional().nullable(),
  notRecorded: z.boolean(),
}).transform((d) => (d.notRecorded ? { ...d, sourceUrl: '' } : d))
  // The recording is mandatory (owner, 17 November 2026), unless the meeting was not recorded or was in person.
  .refine((d) => d.notRecorded || d.sourceUrl !== '', { message: 'Paste the recording link, or tick "Not recorded or in person".', path: ['sourceUrl'] })
  .refine((d) => d.notRecorded || !parseMeetingLink(d.sourceUrl).isJoinLink, { message: 'That is a link to join the meeting, not its recording. Paste the recording link from OneDrive.', path: ['sourceUrl'] });

function readForm(formData: FormData) {
  return MeetingSchema.safeParse({
    notRecorded: formData.get('notRecorded') === 'on',
    title: formData.get('title'),
    sourceUrl: formData.get('sourceUrl') ?? '',
    bookedById: formData.get('bookedById'),
    occurredAt: formData.get('occurredAt'),
    products: formData.getAll('products').map(String),
    transcript: formData.get('transcript') || null,
  });
}

/** Who on a saved meeting is neither on the team nor a prospect: guests typed in by name. */
function guestsOf(attendees: { personId: string | null; userId: string | null; name: string | null; email: string | null; prospect: boolean }[]): AttendeeSelection[] {
  return attendees.filter((a) => !a.userId && !a.prospect).map((a) => ({ name: a.name, email: a.email }));
}
const prospectsOf = (attendees: { personId: string | null; prospect: boolean }[]) => attendees.flatMap((a) => (a.prospect && a.personId ? [a.personId] : []));

export async function createMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canCreateMeeting(user)) return { ok: false, error: 'You cannot add meetings.' };
  const parsed = readForm(formData);
  if (!parsed.success) return { ok: false, error: issueText(parsed.error.issues) };
  const d = parsed.data;
  if (!(await prisma.user.findFirst({ where: { id: d.bookedById, active: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true } }))) return { ok: false, error: 'Choose who booked the meeting.' };
  const day = parseMeetingDay(d.occurredAt);
  if (!day) return { ok: false, error: 'Pick a valid date.' };
  const occurredAt = meetingDayInstant(day);
  // No link is a meeting without a recording; a SharePoint, OneDrive or Drive link often hands out
  // the file itself when asked, and then the recording plays natively and the transcript follows it.
  // A SharePoint sharing link that does not plays through SharePoint's own player, from Graph.
  const link = d.sourceUrl ? parseMeetingLink(d.sourceUrl) : null;
  const [resolved, player] = await Promise.all([
    link && !link.mediaUrl && !link.isJoinLink ? inspectLink(d.sourceUrl) : null,
    link && !link.embedUrl ? sharePointPlayer(d.sourceUrl) : null,
  ]);
  const mediaUrl = link?.mediaUrl ?? resolved?.mediaUrl ?? null;
  if (link && link.provider === 'OTHER' && link.note?.includes('does not look like a URL')) return { ok: false, error: link.note };

  const people = await meetingPeople(formData, user.id);
  if ('error' in people) return { ok: false, error: people.error };
  const { attendees, prospectIds } = people;
  // No account to pick: the meeting is with the company its prospects work at.
  const company = await meetingCompany(prospectIds);
  const transcript = d.transcript?.trim() || resolved?.transcript || null;
  // A declined meeting does not come back as a new one (owner, 20 Nov 2026).
  const declined = await declinedTwin(prospectIds, occurredAt, null);
  if (declined) return { ok: false, error: declined };
  // No recording link: it waits for the booker's Sales Leader, unless whoever adds it may approve it.
  const approval = await approvalForSave({ sourceUrl: d.sourceUrl, bookedById: d.bookedById }, null, toActor(user));

  // S21: the meeting, its number checks and its audit entry are saved together or not at all, so a
  // failed audit write never reports an error for a meeting that was saved (and a retry never duplicates it).
  const checks = idList(formData, 'numberChecksJson');
  const meeting = await prisma.$transaction(async (tx) => {
    const created = await tx.meeting.create({
      data: {
        title: d.title,
        bookedById: d.bookedById,
        provider: link?.provider ?? 'OTHER',
        sourceUrl: d.sourceUrl.trim(),
        embedUrl: link?.embedUrl ?? player?.embedUrl ?? null,
        mediaUrl,
        notRecorded: d.notRecorded,
        ...libraryFieldsFor(d.sourceUrl),
        occurredAt,
        companyId: company.id,
        companyName: company.name,
        products: d.products,
        transcript,
        transcriptFormat: transcript ? detectTranscriptFormat(transcript) : null,
        createdById: user.id,
        ...approval.data,
        attendees: { create: attendees },
      },
    });
    // A number someone doubted while adding it is checked against this meeting.
    if (checks.length) await tx.meetingNumberTicket.updateMany({ where: { id: { in: checks }, raisedById: user.id, meetingId: null }, data: { meetingId: created.id } });
    await logAudit({ entityType: 'meeting', entityId: created.id, action: 'created', actor: userActor(user), details: { title: created.title, provider: created.provider, attendees: attendees.length, prospects: prospectIds.length } }, tx);
    return created;
  });
  // Numbered, then written to Twenty with the meetings whose numbers it moved.
  await afterMeetingChange(meeting.id, prospectIds, !transcript && needsPlayer(meeting.sourceUrl), user);
  const asked = approval.ask ? await askForApproval(meeting.id, user) : '';
  revalidatePath('/meetings');
  revalidatePath('/home');
  if (company.id) revalidatePath(`/accounts/${company.id}`);
  return { ok: true, message: asked ? `Meeting added. ${asked}` : 'Meeting added.', redirectTo: `/meetings/${meeting.id}` };
}

export async function updateMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const existing = await prisma.meeting.findUnique({ where: { id }, include: { attendees: true } });
  if (!existing) return { ok: false, error: 'Meeting not found.' };
  if (existing.approval === 'DECLINED') return { ok: false, error: 'This meeting was declined. Add it back from Meetings > Approval before changing it.' };
  if (!(await mayManageMeeting(user, existing))) return { ok: false, error: whyNotManageMeeting(toActor(user), 'edit this meeting') };
  const parsed = readForm(formData);
  if (!parsed.success) return { ok: false, error: issueText(parsed.error.issues) };
  const d = parsed.data;
  if (!(await prisma.user.findFirst({ where: { id: d.bookedById, active: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true } }))) return { ok: false, error: 'Choose who booked the meeting.' };
  const day = parseMeetingDay(d.occurredAt);
  if (!day) return { ok: false, error: 'Pick a valid date.' };
  const occurredAt = meetingDayInstant(day);
  // No link is a meeting without a recording; a SharePoint, OneDrive or Drive link often hands out
  // the file itself when asked, and then the recording plays natively and the transcript follows it.
  const link = d.sourceUrl ? parseMeetingLink(d.sourceUrl) : null;
  const sameLink = d.sourceUrl.trim() === existing.sourceUrl;
  // The same link keeps the player it has; one saved before Microsoft let Cadence look gets one now.
  const keptPlayer = sameLink && existing.embedUrl && parseMeetingLink(existing.embedUrl).embedUrl ? existing.embedUrl : null;
  const [resolved, player] = await Promise.all([
    !sameLink && link && !link.mediaUrl && !link.isJoinLink ? inspectLink(d.sourceUrl) : null,
    link && !link.embedUrl && !keptPlayer ? sharePointPlayer(d.sourceUrl) : null,
  ]);
  const mediaUrl = sameLink ? existing.mediaUrl : link?.mediaUrl ?? resolved?.mediaUrl ?? null;
  const people = await meetingPeople(formData, existing.createdById, guestsOf(existing.attendees));
  if ('error' in people) return { ok: false, error: people.error };
  const { attendees, prospectIds } = people;
  const company = await meetingCompany(prospectIds);
  let transcript = d.transcript?.trim() || resolved?.transcript || null;
  // S18: a transcript that arrived (from Teams, or pasted by a colleague) while this form was open
  // is kept when the form left its transcript as it was, and not silently replaced when it did not.
  const opened = formData.get('transcriptKey');
  if (typeof opened === 'string' && opened && transcriptKey(existing.transcript) !== opened) {
    if (transcriptKey(d.transcript) === opened) transcript = existing.transcript;
    else if (transcriptKey(transcript) !== transcriptKey(existing.transcript)) return { ok: false, error: 'The transcript changed while you had this form open. Reload the page to see it, then make your change again.' };
  }
  // Only a change of day or prospects can turn this meeting into one that was declined: the genuine
  // meeting beside a declined duplicate stays editable.
  const before = new Set(prospectsOf(existing.attendees));
  const moved = existing.occurredAt.getTime() !== occurredAt.getTime() || prospectIds.some((p) => !before.has(p));
  const declined = moved ? await declinedTwin(prospectIds, occurredAt, id) : null;
  if (declined) return { ok: false, error: declined };
  const approval = await approvalForSave({ sourceUrl: d.sourceUrl, bookedById: d.bookedById }, existing, toActor(user));
  // Owner, 21 Nov 2026: only the FO named in Booked by takes a waiting meeting out of approval with a
  // link. Those who decide on it (its Sales Leader, an admin) may too: they could approve it anyway.
  if (approval.cleared && existing.bookedById !== user.id && !canApproveMeeting(toActor(user), { bookedById: existing.bookedById, bookerPodIds: await bookerPodIds(existing.bookedById) })) {
    const booker = existing.bookedById ? (await prisma.user.findUnique({ where: { id: existing.bookedById }, select: { name: true } }))?.name : null;
    return { ok: false, error: `This meeting is waiting for approval. Only ${booker ?? 'the FO who booked it'}, who booked it, can add its recording link; its Sales Leader or an admin can approve or decline it.` };
  }

  await prisma.$transaction(async (tx) => {
    await tx.meetingAttendee.deleteMany({ where: { meetingId: id } });
    await tx.meeting.update({
      where: { id },
      data: {
        editedAt: new Date(),
        title: d.title,
      bookedById: d.bookedById,
        provider: link?.provider ?? 'OTHER',
        sourceUrl: d.sourceUrl.trim(),
        embedUrl: link?.embedUrl ?? keptPlayer ?? player?.embedUrl ?? null,
        mediaUrl,
        notRecorded: d.notRecorded,
        ...libraryFieldsFor(d.sourceUrl, existing),
        occurredAt,
        companyId: company.id,
        companyName: company.name,
        products: d.products,
        transcript,
        transcriptFormat: transcript ? detectTranscriptFormat(transcript) : null,
        // A changed transcript invalidates any analysis.
        ...(transcript !== existing.transcript ? { analysis: Prisma.DbNull, analysisStatus: 'NONE' as const, analysedAt: null, analysisModel: null, analysisError: null } : {}),
        ...approval.data,
        attendees: { create: attendees },
      },
    });
  });
  // S20: what changed, old and new, for the fields that decide credit and numbering.
  const was = { title: existing.title, bookedById: existing.bookedById, day: meetingDay(existing.occurredAt), sourceUrl: existing.sourceUrl, products: existing.products.join(','), prospects: [...new Set(prospectsOf(existing.attendees))].sort().join(',') };
  const now = { title: d.title, bookedById: d.bookedById, day, sourceUrl: d.sourceUrl.trim(), products: d.products.join(','), prospects: [...new Set(prospectIds)].sort().join(',') };
  const changes = Object.fromEntries((Object.keys(was) as (keyof typeof was)[]).filter((k) => was[k] !== now[k]).map((k) => [k, { from: was[k], to: now[k] }]));
  await logAudit({ entityType: 'meeting', entityId: id, action: 'updated', actor: userActor(user), details: { changes, transcriptChanged: transcript !== existing.transcript } });
  // Everyone it was with before and after: a prospect taken off moves their later meetings down.
  await afterMeetingChange(id, [...prospectIds, ...prospectsOf(existing.attendees)], !transcript && needsPlayer(d.sourceUrl), user);
  if (approval.cleared) await settleApprovalAsks(id);
  const asked = approval.ask ? await askForApproval(id, user) : '';
  revalidatePath('/meetings');
  revalidatePath(`/meetings/${id}`);
  revalidatePath('/meetings/approval');
  revalidatePath('/accounts');
  if (existing.companyId) revalidatePath(`/accounts/${existing.companyId}`);
  if (company.id) revalidatePath(`/accounts/${company.id}`);
  return { ok: true, message: asked ? `Saved. ${asked}` : 'Saved.' };
}

/**
 * Owner, 21 Nov 2026: the FO named in Booked by may add the recording link to their meeting waiting
 * for approval, from Meetings > Waiting for approval or the meeting itself. With a link there is
 * nothing to approve, so it leaves the list and the approvers' bell lines say why. The link is read
 * as the meeting form reads it. The link comes as `reason`, from the confirm dialog's box.
 */
export async function addRecordingLinkAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const raw = String(formData.get('reason') ?? formData.get('sourceUrl') ?? '').trim();
  const existing = await prisma.meeting.findUnique({ where: { id }, select: { id: true, title: true, approval: true, review: true, bookedById: true, sourceUrl: true, transcript: true, companyId: true, bookedBy: { select: { name: true } }, attendees: { select: { personId: true, prospect: true } } } });
  if (!existing) return { ok: false, error: 'Meeting not found.' };
  if (existing.bookedById !== user.id) return { ok: false, error: `Only ${existing.bookedBy?.name ?? 'the FO who booked it'}, who booked this meeting, can add its recording link. Its Sales Leader or an admin approves or declines it.` };
  if (existing.approval !== 'WAITING' || existing.review !== 'APPROVED') return { ok: false, error: existing.approval === 'DECLINED' ? 'This meeting was declined. Its Sales Leader, Biz Ops or an admin can add it back.' : 'This meeting is not waiting for approval any more.' };
  const url = raw ? extractRecordingUrl(raw).trim() : '';
  if (!url) return { ok: false, error: 'Paste the recording link.' };
  if (url.length > 8192 || !/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: 'Use an http or https recording link.' };
  const link = parseMeetingLink(url);
  if (link.isJoinLink) return { ok: false, error: 'That is a link to join the meeting, not its recording. Paste the recording link from OneDrive.' };
  if (link.provider === 'OTHER' && link.note?.includes('does not look like a URL')) return { ok: false, error: link.note };
  const [resolved, player] = await Promise.all([
    !link.mediaUrl ? inspectLink(url) : null,
    !link.embedUrl ? sharePointPlayer(url) : null,
  ]);
  const transcript = existing.transcript || resolved?.transcript || null;
  const now = new Date();
  const done = await prisma.$transaction(async (tx) => {
    // Only while it still waits: a decision made a moment ago stands.
    const r = await tx.meeting.updateMany({
      where: { id, approval: 'WAITING', review: 'APPROVED' },
      data: {
        editedAt: now,
        provider: link.provider,
        sourceUrl: url,
        embedUrl: link.embedUrl ?? player?.embedUrl ?? null,
        mediaUrl: link.mediaUrl ?? resolved?.mediaUrl ?? null,
        notRecorded: false,
        ...libraryFieldsFor(url, existing),
        ...(transcript !== existing.transcript ? { transcript, transcriptFormat: transcript ? detectTranscriptFormat(transcript) : null } : {}),
        approval: null, approvalById: null, approvalAt: null,
      },
    });
    if (!r.count) return false;
    await logAudit({ entityType: 'meeting', entityId: id, action: 'recording_link_added', actor: userActor(user), details: { title: existing.title, changes: { sourceUrl: { from: existing.sourceUrl, to: url } } } }, tx);
    return true;
  });
  if (!done) return { ok: false, error: 'Someone decided on this meeting a moment ago. Reload to see what they chose.' };
  await settleApprovalAsks(id, 'link_added', now);
  // It counts now: numbered with its prospects and written to the CRM with its link; a SharePoint
  // recording gets its Teams transcript first.
  await afterMeetingChange(id, prospectsOf(existing.attendees), !transcript && needsPlayer(url), user);
  revalidatePath('/meetings');
  revalidatePath('/meetings/approval');
  revalidatePath(`/meetings/${id}`);
  if (existing.companyId) revalidatePath(`/accounts/${existing.companyId}`);
  return { ok: true, message: `Recording link added to "${existing.title}". It needs no approval now.` };
}

export async function updateMeetingAttendeesAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const meeting = await prisma.meeting.findUnique({ where: { id }, select: { id: true, createdById: true, companyId: true, attendees: true, approval: true } });
  if (!meeting) return { ok: false, error: 'Meeting not found.' };
  if (meeting.approval === 'DECLINED') return { ok: false, error: 'This meeting was declined. Add it back from Meetings > Approval before changing it.' };
  if (!(await mayManageMeeting(user, meeting))) return { ok: false, error: whyNotManageMeeting(toActor(user), 'change who attended this meeting') };
  const people = await meetingPeople(formData, meeting.createdById, guestsOf(meeting.attendees));
  if ('error' in people) return { ok: false, error: people.error };
  const { attendees, prospectIds } = people;
  const company = await meetingCompany(prospectIds);
  await prisma.$transaction(async (tx) => {
    await tx.meetingAttendee.deleteMany({ where: { meetingId: id } });
    await tx.meeting.update({ where: { id }, data: { companyId: company.id, companyName: company.name, attendees: { create: attendees }, analysis: Prisma.DbNull, analysisStatus: 'NONE', analysedAt: null, analysisModel: null, analysisError: null } });
  });
  await logAudit({ entityType: 'meeting', entityId: id, action: 'attendees_updated', actor: userActor(user), details: { attendees: attendees.length, prospects: prospectIds.length } });
  await afterMeetingChange(id, [...prospectIds, ...prospectsOf(meeting.attendees)]);
  revalidatePath(`/meetings/${id}`);
  revalidatePath('/meetings');
  revalidatePath('/reports');
  if (meeting.companyId) revalidatePath(`/accounts/${meeting.companyId}`);
  return { ok: true, message: 'Attendees updated.' };
}

/** Star or unstar a meeting for the signed-in user. Everyone can read every meeting, so everyone can star one. */
export async function toggleMeetingFavouriteAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const meetingId = String(formData.get('meetingId') ?? '');
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { id: true } });
  if (!meeting) return { ok: false, error: 'That meeting no longer exists.' };
  const key = { userId_meetingId: { userId: user.id, meetingId } };
  const existing = await prisma.meetingFavourite.findUnique({ where: key });
  if (existing) await prisma.meetingFavourite.delete({ where: key });
  else await prisma.meetingFavourite.create({ data: { userId: user.id, meetingId } });
  revalidatePath('/meetings');
  revalidatePath(`/meetings/${meetingId}`);
  return { ok: true, message: existing ? 'Removed from favourites.' : 'Added to favourites.' };
}

export async function deleteMeetingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  const existing = await prisma.meeting.findUnique({ where: { id }, include: { attendees: { select: { personId: true, prospect: true } } } });
  if (!existing || existing.review === 'DISMISSED') return { ok: false, error: 'Meeting not found.' };
  if (!(await mayManageMeeting(user, existing))) return { ok: false, error: whyNotManageMeeting(toActor(user), 'delete this meeting') };
  await prisma.meeting.delete({ where: { id } });
  if (existing.approval === 'WAITING') await settleApprovalAsks(id, 'deleted');
  await logAudit({ entityType: 'meeting', entityId: id, action: 'deleted', actor: userActor(user), details: { title: existing.title } });
  await afterResponse(() => removeMeetingFromCrm(existing));
  // Its prospects' later meetings each move down one.
  await afterMeetingChange(null, prospectsOf(existing.attendees));
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

  if (!(await mayManageMeeting(user, meeting))) return { ok: false, error: whyNotManageMeeting(toActor(user), 'analyse this meeting') };
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
    const saved = await prisma.meeting.updateMany({
      where: { id, transcript: meeting.transcript, analysisStatus: 'PENDING' },
      data: { analysis, analysisStatus: 'READY', analysisModel: analyzer.name, analysedAt: new Date(), analysisError: null },
    });
    if (!saved.count) return { ok: false, error: 'The transcript changed during analysis. Run analysis again for the current transcript.' };
    await logAudit({ entityType: 'meeting', entityId: id, action: 'analysed', actor: userActor(user), details: { model: analyzer.name } });
    revalidatePath(`/meetings/${id}`);
    return { ok: true, message: `Analysed with ${analyzer.name}.` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.meeting.updateMany({ where: { id, transcript: meeting.transcript, analysisStatus: 'PENDING' }, data: { analysisStatus: 'FAILED', analysisError: message } });
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
  if (!(await mayManageMeeting(user, meeting))) return { ok: false, error: whyNotManageMeeting(toActor(user), 'edit this meeting') };
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

// ---------------------------------------------------------------------------
// Adding a meeting from a link: what the link says about itself, and who spoke in the transcript
// ---------------------------------------------------------------------------

export type LinkSuggestion = {
  transcript?: string;
  provider: string;
  label: string;
  isJoinLink: boolean;
  playsInline: boolean;
  title: string | null;
  /** YYYY-MM-DD when the page, the file or the link carries a date. */
  date: string | null;
  mediaUrl: string | null;
  /** What plays in the meeting page's player, when the link can be framed. */
  embedUrl: string | null;
  /** A Teams recording whose transcript Microsoft may hand over: the form asks for it next. */
  transcriptFromTeams: boolean;
  /** The link belongs to a meeting Cadence already has. */
  existingMeetingId?: string | null;
};

/** A sign-in page is not a meeting: its title must never become one. */
const SIGN_IN = /\b(sign[\s-]?in|log[\s-]?in|sign on|single sign-on|authenticat|access denied|request access)\b/i;
/** Nor is the service's own name for its page ("Join conversation", "Check out loom.com"). */
const GENERIC = /^(join conversation|join (our )?(cloud hd )?video meeting|video conferencing|check out loom|loom|youtube|vimeo|zoom|fathom|microsoft teams|microsoft stream|google meet|google drive|onedrive|sharepoint|dropbox|untitled)\b/i;

/**
 * Everything a pasted link can tell us before anyone types: which service it is, whether it plays
 * here (and the player link it plays through), and from the page or the file a title and a date.
 * A link to a meeting Cadence already has says so.
 */
export async function inspectMeetingLinkAction(raw: string, exceptMeetingId?: string | null): Promise<{ ok: true; data: LinkSuggestion } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!canCreateMeeting(user)) return { ok: false, error: 'You cannot add meetings.' };
  const url = extractRecordingUrl(String(raw ?? ''));
  const link = parseMeetingLink(url);
  if (link.provider === 'OTHER' && link.note?.includes('does not look like a URL')) return { ok: false, error: link.note };
  const base = { provider: link.provider, label: link.label, isJoinLink: link.isJoinLink, playsInline: Boolean(link.mediaUrl || link.embedUrl), mediaUrl: link.mediaUrl, embedUrl: link.embedUrl, transcriptFromTeams: false };

  // Already here: this link's meeting within a few hours of now. A personal room's other meetings,
  // earlier in the week or next week, are other meetings.
  const key = linkKey(url);
  const needle = linkNeedle(url);
  const around = 24 * 3_600_000;
  const candidates = key && needle ? await prisma.meeting.findMany({ where: { review: { not: 'DISMISSED' }, ...(exceptMeetingId ? { id: { not: exceptMeetingId } } : {}), sourceUrl: { contains: needle, mode: 'insensitive' }, occurredAt: { gte: new Date(Date.now() - around), lte: new Date(Date.now() + around) } }, orderBy: { occurredAt: 'desc' }, take: 20, select: { id: true, sourceUrl: true } }) : [];
  const already = candidates.find((m) => linkKey(m.sourceUrl) === key);
  if (already) return { ok: true, data: { ...base, title: null, date: null, existingMeetingId: already.id } };

  // A SharePoint page is a sign-in wall to the server; Graph names its file, and Teams names the
  // file after the meeting and its day.
  const [page, found] = await Promise.all([inspectLink(url), link.embedUrl ? null : sharePointRecording(url)]);
  const recording = found?.recording ?? null;
  // S01: every recording Cadence looks up with its own Microsoft permission is logged with who asked.
  // (Its player still plays only with the viewer's own access to the file.)
  if (recording) await logAudit({ entityType: 'meeting', entityId: exceptMeetingId ?? 'pasted-link', action: 'recording_looked_up', actor: userActor(user), details: { driveId: recording.file?.driveId ?? null, title: recording.title } });
  const embedUrl = link.embedUrl ?? recording?.embedUrl ?? null;
  const cleaned = page.title?.replace(/\s*[|·-]\s*(Microsoft Stream|SharePoint|Google Drive|Zoom|OneDrive|Google Meet|Microsoft Teams).*$/i, '').trim() || null;
  const named = cleaned && !link.isJoinLink && !SIGN_IN.test(cleaned) && !GENERIC.test(cleaned) ? cleaned : null;
  const title = named ?? recording?.title ?? null;
  const date = named ? page.date : recording?.date ?? page.date ?? null;
  const mediaUrl = page.mediaUrl ?? link.mediaUrl;
  const transcriptFromTeams = Boolean(!page.transcript && recording?.file && found && mayReadTranscripts(found.token.roles));
  return { ok: true, data: { ...base, embedUrl, playsInline: Boolean(mediaUrl || embedUrl), title, date, mediaUrl, transcript: page.transcript, transcriptFromTeams } };
}

/**
 * The Teams transcript of a pasted SharePoint recording, asked after the link was read (a few
 * seconds on Microsoft's side, so the player shows first). `teamUserIds` may have organized it.
 */
export async function linkTranscriptAction(raw: string, teamUserIds: string[] = []): Promise<{ ok: true; transcript: string | null } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!canCreateMeeting(user)) return { ok: false, error: 'You cannot add meetings.' };
  const ids = IdList.safeParse(teamUserIds);
  const found = await sharePointRecording(extractRecordingUrl(String(raw ?? '')));
  // S01: the transcript is for the user asking, and only when they were on that meeting; logged.
  return { ok: true, transcript: await transcriptForRecording(found?.recording.file ?? null, ids.success ? ids.data : [], { actor: userActor(user), viewerIds: [user.id] }) };
}

/**
 * The people who spoke in a transcript, where a speaker's name is someone on the team or someone
 * in Twenty: offered for the two lists, never guessed beyond an exact name.
 */
export async function peopleFromTranscriptAction(raw: string): Promise<{ ok: true; team: TeamOption[]; prospects: ProspectOption[] } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!canCreateMeeting(user)) return { ok: false, error: 'You cannot add meetings.' };
  const { cues } = parseTranscript(String(raw ?? ''));
  const bare = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const speakers = [...new Set(cues.map((c) => c.speaker).filter((s): s is string => Boolean(s)).map(bare).filter(Boolean))].slice(0, 50);
  if (!speakers.length) return { ok: true, team: [], prospects: [] };
  const lower = new Set(speakers.map((s) => s.toLowerCase()));
  const [team, people] = await Promise.all([
    findTeam(''),
    prisma.personCache.findMany({
      where: { AND: [{ deletedAt: null, OR: speakers.map((s) => { const [first, ...rest] = s.split(/\s+/); return { firstName: { equals: first, mode: 'insensitive' as const }, lastName: { equals: rest.join(' '), mode: 'insensitive' as const } }; }) }, await externalPeopleWhere({ keepBlocked: true })] },
      select: { id: true, firstName: true, lastName: true, email: true, companyName: true, jobTitle: true },
      take: 50,
    }),
  ]);
  const onTeam = team.filter((u) => lower.has(u.name.toLowerCase()));
  // One record per speaker: a name Twenty holds twice is left for the FO to pick.
  const prospects = speakers.flatMap((s) => {
    const hits = people.filter((p) => `${p.firstName} ${p.lastName}`.trim().toLowerCase() === s.toLowerCase());
    return hits.length === 1 && !onTeam.some((u) => u.name.toLowerCase() === s.toLowerCase()) ? [hits[0]] : [];
  });
  return { ok: true, team: onTeam, prospects: prospects.map((p) => ({ personId: p.id, name: `${p.firstName} ${p.lastName}`.trim(), email: p.email, companyName: p.companyName, jobTitle: p.jobTitle })) };
}
