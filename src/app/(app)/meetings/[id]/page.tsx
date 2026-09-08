import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatInstant } from '@/lib/dates';
import { parseAnalysis } from '@/lib/meetings/analysis';
import { parseMeetingLink, PROVIDER_LABELS } from '@/lib/meetings/providers';
import { deleteMeetingAction, saveTranscriptAction } from '@/lib/actions/meetings';
import { ActionButton, ActionForm } from '@/components/action-form';
import { MeetingAnalysisPanel } from '@/components/meetings/meeting-analysis';
import { MeetingStage } from '@/components/meetings/meeting-stage';
import { IconExternal } from '@/components/icons';
import { Avatar, Badge, Card, EmptyState, Field, KeyValue, RecordHeader } from '@/components/ui';

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: { attendees: { orderBy: [{ host: 'desc' }, { external: 'asc' }, { name: 'asc' }] }, createdBy: { select: { name: true } } },
  });
  if (!meeting) notFound();

  const link = parseMeetingLink(meeting.sourceUrl);
  const analysis = parseAnalysis(meeting.analysis);
  const mayEdit = meeting.createdById === user.id || isAdmin(toActor(user));
  const externals = meeting.attendees.filter((a) => a.external);

  return (
    <>
      <div className="px-6 pt-2">
        <RecordHeader
          name={meeting.title}
          shape="square"
          sub={
            <>
              {formatInstant(meeting.occurredAt, user.timezone)}
              {meeting.durationSec ? ` · ${Math.round(meeting.durationSec / 60)} min` : ''}
              {' · '}
              {PROVIDER_LABELS[meeting.provider]}
              {meeting.companyId ? (
                <>
                  {' · '}
                  <Link href={`/accounts/${meeting.companyId}`} className="text-brand-700 hover:underline">
                    {meeting.companyName}
                  </Link>
                </>
              ) : meeting.companyName ? ` · ${meeting.companyName}` : ''}
              {meeting.createdBy ? ` · added by ${meeting.createdBy.name}` : ''}
            </>
          }
          badges={
            <>
              {externals.length ? <Badge tone="green" dot>{externals.length} external</Badge> : <Badge tone="gray">internal only</Badge>}
              {meeting.transcript ? <Badge tone="blue">transcript</Badge> : null}
            </>
          }
          actions={
            <>
              <a href={meeting.sourceUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                <IconExternal size={13} /> Open original
              </a>
              {mayEdit ? (
                <Link href={`/meetings/${meeting.id}/edit`} className="btn-secondary btn-sm">
                  Edit
                </Link>
              ) : null}
              {mayEdit ? (
                <ActionButton action={deleteMeetingAction} payload={{ meetingId: meeting.id }} className="btn-ghost btn-sm text-red-600" confirm="Delete this meeting and its transcript?">
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

      <div className="grid gap-3 px-6 pb-8 pt-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-3">
          <MeetingStage
            title={meeting.title}
            provider={meeting.provider}
            sourceUrl={meeting.sourceUrl}
            embedUrl={meeting.embedUrl}
            mediaUrl={meeting.mediaUrl}
            providerLabel={link.label}
            providerNote={link.note}
            isJoinLink={link.isJoinLink}
            transcript={meeting.transcript}
            transcriptFormat={meeting.transcriptFormat}
          />

          {meeting.notes ? (
            <Card title="Notes">
              <p className="whitespace-pre-wrap px-4 py-3 text-[13px] leading-relaxed text-ink-700">{meeting.notes}</p>
            </Card>
          ) : null}

          {mayEdit && !meeting.transcript ? (
            <Card title="Add a transcript">
              <ActionForm action={saveTranscriptAction} className="space-y-3 p-4">
                <input type="hidden" name="meetingId" value={meeting.id} />
                <Field label="Paste WebVTT, SRT or plain text" hint="Teams: Recording > ... > Transcript > Download. Zoom: Recordings > audio transcript. Meet: the transcript file in Drive.">
                  <textarea name="transcript" rows={8} className="font-mono !text-[12px]" placeholder={'WEBVTT\n\n00:00:03.000 --> 00:00:07.500\n<v Alisa>Thanks for making the time today.'} />
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
          />

          <Card title={`Attendees (${meeting.attendees.length})`}>
            {meeting.attendees.length === 0 ? (
              <EmptyState title="No attendees recorded" hint={mayEdit ? 'Add them in Edit so external meetings are counted.' : undefined} />
            ) : (
              <ul className="divide-y divide-line">
                {meeting.attendees.map((a) => {
                  const label = a.name ?? a.email ?? 'Unknown';
                  return (
                    <li key={a.id} className="flex items-center gap-2.5 px-4 py-2.5">
                      <Avatar name={label} shape="circle" size={26} />
                      <span className="min-w-0 flex-1">
                        {a.personId ? (
                          <Link href={`/people/${a.personId}`} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">
                            {label}
                          </Link>
                        ) : (
                          <span className="block truncate text-[13px] font-medium text-ink-900">{label}</span>
                        )}
                        {a.email ? <span className="block truncate text-[11.5px] text-ink-400">{a.email}</span> : null}
                      </span>
                      <span className="flex shrink-0 gap-1">
                        {a.host ? <Badge tone="blue">host</Badge> : null}
                        {a.external ? <Badge tone="green">external</Badge> : <Badge tone="gray">internal</Badge>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="Recording">
            <div className="p-4">
              <KeyValue
                items={[
                  { k: 'Provider', v: link.label },
                  { k: 'Playback', v: meeting.mediaUrl ? 'native player (seekable)' : meeting.embedUrl ? 'embedded player' : 'opens in a new tab' },
                  { k: 'Link', v: <span className="break-all font-mono text-[11px]">{meeting.sourceUrl}</span> },
                ]}
              />
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}
