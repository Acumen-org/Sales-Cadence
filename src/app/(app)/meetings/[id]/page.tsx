import Link from 'next/link';
import { TranscriptInput } from '@/components/meetings/transcript-input';
import { ProductTags } from '@/components/meetings/product-tags';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { FavouriteButton } from '@/components/meetings/favourite-button';
import { formatLocalDate } from '@/lib/dates';
import { meetingDay } from '@/lib/meetings/day';
import { parseAnalysis } from '@/lib/meetings/analysis';
import { parseTranscript, talkShare } from '@/lib/meetings/transcript';
import { parseMeetingLink, platformLabel } from '@/lib/meetings/providers';
import { canManageMeetingAction, deleteMeetingAction, saveTranscriptAction } from '@/lib/actions/meetings';
import { ActionButton, ActionForm } from '@/components/action-form';
import { attendeeIsExternal } from '@/lib/meetings-query';
import { MeetingAnalysisPanel } from '@/components/meetings/meeting-analysis';
import { AttendeeEditor } from '@/components/meetings/attendee-editor';
import { MeetingStage } from '@/components/meetings/meeting-stage';
import { IconExternal } from '@/components/icons';
import { ordinal } from '@/lib/meetings/numbering';
import { prospectOptions, teamOptions } from '@/lib/meetings/people-search';
import { Avatar, Badge, Card, EmptyState, Field, KeyValue, RecordFields, RecordHeader } from '@/components/ui';

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const meeting = await prisma.meeting.findFirst({
    // Scoped, not merely fetched: a transcript is a prospect conversation. Never one removed.
    where: { id, review: 'APPROVED' },
    include: { attendees: { orderBy: [{ host: 'desc' }, { external: 'asc' }, { name: 'asc' }], include: { person: { select: { companyName: true } } } }, createdBy: { select: { name: true } }, bookedBy: { select: { name: true } }, favourites: { where: { userId: user.id }, select: { userId: true } } },
  });
  if (!meeting) notFound();

  const link = parseMeetingLink(meeting.sourceUrl);
  // A sharing link Cadence found SharePoint's player for reads as that player, not as the link.
  const player = meeting.embedUrl && !link.embedUrl ? parseMeetingLink(meeting.embedUrl) : link;
  const analysis = parseAnalysis(meeting.analysis);
  // Who spoke how much, from the transcript as it stands - the same normalised cues the reader sees.
  const liveTalk = meeting.transcript ? talkShare(parseTranscript(meeting.transcript, (meeting.transcriptFormat as never) ?? undefined).cues) : [];
  const mayEdit = await canManageMeetingAction(id);
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
      <div className="px-6 pt-2">
        <RecordHeader
          name={meeting.title}
          shape="square"
          badges={
            <>
              {n ? <Badge tone={n === 1 ? 'green' : 'gray'}>{n === 1 ? 'First meeting' : `Follow-up · ${ordinal(n)} meeting`}</Badge> : null}
              {externals.length ? <Badge tone="green">{externals.length} external</Badge> : <Badge tone="gray">{meeting.attendees.length ? 'Internal only' : 'No attendees'}</Badge>}
              {meeting.transcript ? <Badge tone="blue">Transcript</Badge> : null}
            </>
          }
          actions={
            <>
              <FavouriteButton meetingId={meeting.id} favourite={meeting.favourites.length > 0} />
              {meeting.sourceUrl ? (
                <a href={meeting.sourceUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                  <IconExternal size={13} /> Open original
                </a>
              ) : null}
              {mayEdit ? (
                <Link href={`/meetings/${meeting.id}/edit`} className="btn-secondary btn-sm">
                  Edit
                </Link>
              ) : null}
              {mayEdit ? (
                <ActionButton action={deleteMeetingAction} payload={{ meetingId: meeting.id }} className="btn-ghost btn-sm text-red-600" confirm="Delete this meeting and its transcript? Its note in Twenty is removed too.">
                  Delete
                </ActionButton>
              ) : null}
              <Link href="/meetings" className="btn-ghost btn-sm">
                All meetings
              </Link>
            </>
          }
        />
      </div>

      <div className="px-6 pt-3">
        <div className="space-y-5 rounded-xl border border-line bg-white p-5">
          <RecordFields className="lg:grid-cols-6" items={[
            { label: 'Date', value: formatLocalDate(meetingDay(meeting.occurredAt), 'long') },
            { label: 'Platform', value: meeting.sourceUrl ? platformLabel(meeting.provider, meeting.sourceUrl) : null },
            { label: 'Account', value: meeting.companyId ? <Link href={`/accounts/${meeting.companyId}`} className="text-brand-700 hover:underline">{meeting.companyName}</Link> : meeting.companyName ?? null },
            { label: 'Booked by', value: meeting.bookedBy?.name ?? null },
            { label: 'Added by', value: meeting.createdBy?.name ?? null },
          ]} />
          <div><div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">Products</div><ProductTags meetingId={meeting.id} products={meeting.products} canEdit={mayEdit} /></div>
        </div>
      </div>
      <div className="grid gap-3 px-6 pb-8 pt-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-3">
          <MeetingStage
            title={meeting.title}
            provider={meeting.provider}
            sourceUrl={meeting.sourceUrl}
            embedUrl={meeting.embedUrl}
            mediaUrl={meeting.mediaUrl}
            providerLabel={link.label}
            providerNote={player.note}
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
            status={meeting.analysisStatus}
            model={meeting.analysisModel}
            analysedAt={meeting.analysedAt}
            error={meeting.analysisError}
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
                  { k: 'Provider', v: link.label },
                ]}
              />
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}
