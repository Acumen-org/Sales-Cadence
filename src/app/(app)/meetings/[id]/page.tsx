import Link from 'next/link';
import { TranscriptInput } from '@/components/meetings/transcript-input';
import { ProductTags } from '@/components/meetings/product-tags';
import { notFound } from 'next/navigation';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { approvalPanel, mayOpenDeclined } from '@/lib/meetings/approval';
import { addMeetingBackAction, approveMeetingAction, declineMeetingAction } from '@/lib/actions/meeting-approval';
import { addMeetingBackConfirm, addRecordingLinkConfirm, declineMeetingConfirm } from '@/lib/confirms';
import { workspaceTimezone } from '@/lib/workspace';
import { Flash } from '@/components/flash';
import { prisma } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { FavouriteButton } from '@/components/meetings/favourite-button';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { meetingDay } from '@/lib/meetings/day';
import { parseAnalysis } from '@/lib/meetings/analysis';
import { parseTranscript, talkShare } from '@/lib/meetings/transcript';
import { parseMeetingLink, platformLabel } from '@/lib/meetings/providers';
import { addRecordingLinkAction, canManageMeetingAction, deleteMeetingAction, saveTranscriptAction } from '@/lib/actions/meetings';
import { ActionButton, ActionForm } from '@/components/action-form';
import { attendeeIsExternal } from '@/lib/meetings-query';
import { MeetingAnalysisPanel } from '@/components/meetings/meeting-analysis';
import { AttendeeEditor } from '@/components/meetings/attendee-editor';
import { MeetingStage } from '@/components/meetings/meeting-stage';
import { IconExternal } from '@/components/icons';
import { NUMBERING_STARTS_WORDS, ordinal } from '@/lib/meetings/numbering';
import { deleteMeetingConfirm } from '@/lib/confirms';
import { prospectOptions, teamOptions } from '@/lib/meetings/people-search';
import { Avatar, Badge, Card, EmptyState, Field, KeyValue, Notice, RecordFields, RecordHeader } from '@/components/ui';

export default async function MeetingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ flash?: string; flashTone?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const meeting = await prisma.meeting.findFirst({
    // Scoped, not merely fetched: a transcript is a prospect conversation. Never one removed; a declined
    // one only for those who may add it back, its booker, whoever added it and the booker's pods
    // (owner, 20 and 21 Nov 2026).
    where: { id, OR: [{ review: 'APPROVED' }, { review: 'DISMISSED', approval: 'DECLINED' }] },
    include: { attendees: { orderBy: [{ host: 'desc' }, { external: 'asc' }, { name: 'asc' }], include: { person: { select: { companyName: true } } } }, createdBy: { select: { name: true } }, bookedBy: { select: { name: true } }, favourites: { where: { userId: user.id }, select: { userId: true } } },
  });
  if (!meeting) notFound();
  const actor = toActor(user);
  const declined = meeting.approval === 'DECLINED';
  if (declined && !(await mayOpenDeclined(actor, meeting))) notFound();
  const approval = await approvalPanel(actor, meeting);
  const tz = workspaceTimezone();

  const link = parseMeetingLink(meeting.sourceUrl);
  // A sharing link Cadence found SharePoint's player for reads as that player, not as the link.
  const player = meeting.embedUrl && !link.embedUrl ? parseMeetingLink(meeting.embedUrl) : link;
  // The company's copy, once made, is what plays and what opens: everyone can see it and it does not
  // expire (src/lib/meetings/library.ts). A direct SharePoint file of the original gives way to it.
  const copied = meeting.libraryStatus === 'DONE' && meeting.libraryEmbedUrl ? { url: meeting.libraryUrl ?? meeting.sourceUrl, embedUrl: meeting.libraryEmbedUrl } : null;
  const mediaUrl = copied && meeting.mediaUrl && /\.sharepoint\.com/i.test(new URL(meeting.mediaUrl, 'https://x').hostname) ? null : meeting.mediaUrl;
  const openUrl = copied?.url ?? meeting.sourceUrl;
  const libraryWords: Record<string, string> = { DONE: 'Saved to the company library', PENDING: 'Waiting to be copied to the company library', COPYING: 'Being copied to the company library', FAILED: 'Not copied to the company library' };
  const analysis = parseAnalysis(meeting.analysis);
  // S27: an analysis "in progress" for over ten minutes was cut off (a restart): offered again.
  const analysisStale = meeting.analysisStatus === 'PENDING' && meeting.updatedAt.getTime() < Date.now() - 10 * 60_000;
  // Who spoke how much, from the transcript as it stands - the same normalised cues the reader sees.
  const liveTalk = meeting.transcript ? talkShare(parseTranscript(meeting.transcript, (meeting.transcriptFormat as never) ?? undefined).cues) : [];
  // A declined meeting is read only until it is added back.
  const mayEdit = !declined && (await canManageMeetingAction(id));
  const { rules } = await getSettings();
  // Externality follows the address and the current domain list, not the flag stored at creation.
  meeting.attendees = meeting.attendees.map((a) => ({ ...a, external: attendeeIsExternal(a, rules.internalDomains) }));
  const externals = meeting.attendees.filter((a) => a.external);
  const team = meeting.attendees.filter((a) => a.userId);
  const prospects = meeting.attendees.filter((a) => a.prospect).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const guests = meeting.attendees.filter((a) => !a.userId && !a.prospect);
  const [teamPicked, prospectsPicked] = mayEdit ? await Promise.all([teamOptions(team.map((a) => a.userId!)), prospectOptions(prospects.map((a) => a.personId!))]) : [[], []];
  const n = meeting.meetingNumber;

  return (
    <>
      {sp.flash ? <Flash message={sp.flash} tone={sp.flashTone === 'error' ? 'error' : 'ok'} /> : null}
      <div className="px-6 pt-2">
        <RecordHeader
          name={meeting.title}
          shape="square"
          badges={
            <>
              {n ? <Badge tone={n === 1 ? 'green' : 'gray'}>{n === 1 ? 'First meeting' : `Follow-up · ${ordinal(n)} meeting`}</Badge> : meeting.approval === 'WAITING' || declined ? null : prospects.length ?<Badge tone="gray">Before {NUMBERING_STARTS_WORDS}, not counted</Badge> : <Badge tone="amber">No prospect, no number</Badge>}
              {externals.length ? <Badge tone="green">{externals.length} external</Badge> : <Badge tone="gray">{meeting.attendees.length ? 'Internal only' : 'No attendees'}</Badge>}
              {meeting.transcript ? <Badge tone="blue">Transcript</Badge> : null}
              {approval?.state === 'WAITING' ? <Badge tone="amber">Waiting for approval</Badge> : approval?.state === 'DECLINED' ? <Badge tone="red">Declined</Badge> : null}
            </>
          }
          actions={
            <>
              <FavouriteButton meetingId={meeting.id} favourite={meeting.favourites.length > 0} />
              {openUrl ? (
                <a href={openUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                  <IconExternal size={13} /> {copied ? 'Open recording' : 'Open original'}
                </a>
              ) : null}
              {mayEdit ? (
                <Link href={`/meetings/${meeting.id}/edit`} className="btn-secondary btn-sm">
                  Edit
                </Link>
              ) : null}
              {mayEdit ? (
                <ActionButton action={deleteMeetingAction} payload={{ meetingId: meeting.id }} className="btn-ghost btn-sm text-red-600" confirm={deleteMeetingConfirm({ title: meeting.title, inCrm: Boolean(meeting.twentyMeetingId || meeting.twentyNoteId) })}>
                  Delete
                </ActionButton>
              ) : null}
              <Link href={declined ? '/meetings/approval?view=declined' : '/meetings'} className="btn-ghost btn-sm">
                {declined ? 'Declined meetings' : 'All meetings'}
              </Link>
            </>
          }
        />
      </div>

      {approval?.state === 'WAITING' ? (
        <div className="px-6 pt-3">
          <Notice tone="warn">
            <div className="flex flex-wrap items-center justify-between gap-3" role="region" aria-label="Approval">
              <span><span className="font-medium">Waiting for approval.</span> This meeting has no recording link, so {approval.approvers} approves or declines it. Until then it has no meeting number and is not in the CRM.</span>
              {approval.mayDecide || approval.mayAddLink ? (
                <span className="flex flex-wrap items-start gap-1.5">
                  {approval.mayDecide ? <>
                    <ActionButton action={approveMeetingAction} payload={{ meetingId: meeting.id }} className="btn-primary btn-sm" flash>Approve</ActionButton>
                    <ActionButton action={declineMeetingAction} payload={{ meetingId: meeting.id }} className="btn-secondary btn-sm text-red-700" confirm={declineMeetingConfirm({ title: meeting.title, bookedBy: meeting.bookedBy?.name ?? null })} flash>Decline</ActionButton>
                  </> : null}
                  {approval.mayAddLink ? <ActionButton action={addRecordingLinkAction} payload={{ meetingId: meeting.id }} className="btn-secondary btn-sm" confirm={addRecordingLinkConfirm({ title: meeting.title })} flash>Add recording link</ActionButton> : null}
                </span>
              ) : null}
            </div>
          </Notice>
        </div>
      ) : approval?.state === 'DECLINED' ? (
        <div className="px-6 pt-3">
          <Notice tone="error">
            <div className="flex flex-wrap items-center justify-between gap-3" role="region" aria-label="Approval">
              <span>
                <span className="font-medium">Declined{approval.declinedBy ? ` by ${approval.declinedBy}` : ''}{approval.declinedAt ? `, ${formatInstant(approval.declinedAt, tz)}` : ''}.</span>{' '}
                {approval.declineReason ? <>Why: {approval.declineReason}. </> : null}
                It is out of Cadence and the CRM. Its Sales Leader, Biz Ops or an admin can add it back.
              </span>
              {approval.mayAddBack ? <ActionButton action={addMeetingBackAction} payload={{ meetingId: meeting.id }} className="btn-secondary btn-sm" confirm={addMeetingBackConfirm({ title: meeting.title, bookedBy: meeting.bookedBy?.name ?? null })} flash>Add back</ActionButton> : null}
            </div>
          </Notice>
        </div>
      ) : null}

      <div className="px-6 pt-3">
        <div className="space-y-5 rounded-xl border border-line bg-white p-5">
          <RecordFields className="lg:grid-cols-6" items={[
            { label: 'Date', value: formatLocalDate(meetingDay(meeting.occurredAt), 'long') },
            { label: 'Platform', value: meeting.sourceUrl ? platformLabel(meeting.provider, meeting.sourceUrl) : meeting.notRecorded ? 'Not recorded or in person' : null },
            { label: 'Account', value: meeting.companyId ? <Link href={`/accounts/${meeting.companyId}`} className="text-brand-700 hover:underline">{meeting.companyName}</Link> : meeting.companyName ?? null },
            { label: 'Booked by', value: meeting.bookedBy?.name ?? null },
            { label: 'Added by', value: meeting.createdBy?.name ?? null },
            ...(approval?.state === 'APPROVED' ? [{ label: 'Approved by', value: `${approval.approvedBy ?? 'Someone'}${approval.approvedAt ? `, ${formatLocalDate(meetingDay(approval.approvedAt), 'short')}` : ''}` }] : []),
          ]} />
          <div><div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">Products</div><ProductTags meetingId={meeting.id} products={meeting.products} canEdit={mayEdit} /></div>
        </div>
      </div>
      <div className="grid gap-3 px-6 pb-8 pt-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-3">
          <MeetingStage
            title={meeting.title}
            provider={meeting.provider}
            sourceUrl={openUrl}
            embedUrl={copied?.embedUrl ?? meeting.embedUrl}
            mediaUrl={mediaUrl}
            providerLabel={copied ? 'Meeting Recordings library' : link.label}
            providerNote={copied ? null : player.note}
            isJoinLink={link.isJoinLink}
            transcript={meeting.transcript}
            transcriptFormat={meeting.transcriptFormat}
          />

          {mayEdit && !meeting.transcript ? (
            <Card title="Add a transcript">
              <ActionForm action={saveTranscriptAction} className="space-y-3 p-4">
                <input type="hidden" name="meetingId" value={meeting.id} />
                <Field label="Transcript">
                  <TranscriptInput name="transcript" label="Transcript" rows={8} />
                </Field>
                <button type="submit" className="btn-primary">
                  Save transcript
                </button>
              </ActionForm>
            </Card>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-3">
          <MeetingAnalysisPanel
            meetingId={meeting.id}
            analysis={analysis}
            status={analysisStale ? 'FAILED' : meeting.analysisStatus}
            model={meeting.analysisModel}
            analysedAt={meeting.analysedAt}
            error={analysisStale ? 'The analysis stopped before it finished. Run it again.' : meeting.analysisError}
            hasTranscript={Boolean(meeting.transcript)}
            canRun={mayEdit}
            talkShare={liveTalk}
          />

          <Card title="Who was there">
            {meeting.attendees.length === 0 ? (
              <EmptyState title="No one recorded" />
            ) : (
              <div className="divide-y divide-line">
                {[
                  { title: 'Prospects', rows: prospects },
                  { title: 'Our team', rows: team },
                  { title: 'Guests', rows: guests },
                ].filter((g) => g.rows.length).map((group) => (
                  <div key={group.title} className="py-1">
                    <div className="px-4 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-ink-400">{group.title}</div>
                    <ul>
                      {group.rows.map((a) => {
                        const label = a.name ?? a.email ?? 'Unknown';
                        const sub = a.prospect ? [a.person?.companyName, a.email].filter(Boolean).join(' · ') : a.email;
                        return (
                          <li key={a.id} className="flex items-center gap-2.5 px-4 py-2">
                            <Avatar name={label} shape="circle" size={26} />
                            <span className="min-w-0 flex-1">
                              {a.personId ? (
                                <Link href={`/people/${a.personId}`} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">{label}</Link>
                              ) : (
                                <span className="block truncate text-[13px] font-medium text-ink-900">{label}</span>
                              )}
                              {sub ? <span className="block truncate text-[11.5px] text-ink-500">{sub}</span> : null}
                            </span>
                            {a.prospect && a.meetingNumber ? <Badge tone={a.meetingNumber === 1 ? 'green' : 'gray'}>{a.meetingNumber === 1 ? '1st meeting' : `${ordinal(a.meetingNumber)} meeting`}</Badge> : null}
                            {a.userId && meeting.bookedById === a.userId ? <Badge tone="blue">Booked it</Badge> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {mayEdit ? <div className="border-t border-line p-3"><AttendeeEditor meetingId={meeting.id} day={meetingDay(meeting.occurredAt)} team={teamPicked} prospects={prospectsPicked} /></div> : null}
          </Card>

          <Card title="Recording">
            <div className="p-4">
              <KeyValue
                items={[
                  { k: 'Provider', v: meeting.sourceUrl ? link.label : meeting.notRecorded ? 'Not recorded or in person' : 'No link' },
                  ...(meeting.libraryStatus ? [{ k: 'Company library', v: <span className="space-y-1"><Badge tone={meeting.libraryStatus === 'DONE' ? 'green' : meeting.libraryStatus === 'FAILED' ? 'amber' : 'gray'}>{libraryWords[meeting.libraryStatus] ?? meeting.libraryStatus}</Badge>{meeting.libraryError && meeting.libraryStatus !== 'DONE' ? <span className="block text-[12px] text-ink-600">{meeting.libraryError}</span> : null}</span> }] : []),
                  ...(copied && meeting.sourceUrl ? [{ k: 'Original', v: <a href={meeting.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Organizer&apos;s OneDrive</a> }] : []),
                ]}
              />
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}
