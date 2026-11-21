import { notFound, redirect } from 'next/navigation';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { canApproveMeeting, ROLES_NEEDING_POD } from '@/lib/auth/rbac';
import { bookerPodIds } from '@/lib/meetings/approval';
import { prisma } from '@/lib/db';
import { canManageMeetingAction } from '@/lib/actions/meetings';
import { MeetingForm } from '@/components/meetings/meeting-form';
import { Notice, PageHeader, Surface } from '@/components/ui';
import { meetingDay } from '@/lib/meetings/day';
import { transcriptKey } from '@/lib/meetings/transcript-key';
import { prospectOptions, teamOptions } from '@/lib/meetings/people-search';

export default async function EditMeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [meeting, fos] = await Promise.all([
    prisma.meeting.findUnique({ where: { id }, include: { attendees: true } }),
    prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  if (!meeting) notFound();
  if (!(await canManageMeetingAction(id))) redirect(`/meetings/${id}`);
  const [team, prospects] = await Promise.all([
    teamOptions(meeting.attendees.flatMap((a) => (a.userId ? [a.userId] : []))),
    prospectOptions(meeting.attendees.flatMap((a) => (a.prospect && a.personId ? [a.personId] : []))),
  ]);
  // Owner, 21 Nov 2026: only the FO named in Booked by (or whoever decides) adds the link that takes a
  // waiting meeting out of approval. Said here, before anyone pastes one.
  const waitingNotMine = meeting.approval === 'WAITING' && meeting.bookedById !== user.id
    && !canApproveMeeting(toActor(user), { bookedById: meeting.bookedById, bookerPodIds: await bookerPodIds(meeting.bookedById) });
  const booker = waitingNotMine ? fos.find((f) => f.id === meeting.bookedById)?.name : null;

  return (
    <>
      <PageHeader title="Edit meeting" subtitle={meeting.title} />
      <div className="max-w-4xl space-y-3 px-6 pb-8 pt-2">
        {waitingNotMine ? <Notice tone="warn">This meeting is waiting for approval. Only {booker ?? 'the FO who booked it'}, who booked it, can add its recording link; you can change everything else.</Notice> : null}
        <Surface>
          <MeetingForm
            mode="edit"
            fos={fos}
            initial={{
              id: meeting.id,
              bookedById: meeting.bookedById ?? '',
              title: meeting.title,
              sourceUrl: meeting.sourceUrl,
              notRecorded: meeting.notRecorded,
              embedUrl: meeting.embedUrl,
              mediaUrl: meeting.mediaUrl,
              occurredAt: meetingDay(meeting.occurredAt),
              team,
              prospects,
              products: meeting.products,
              transcript: meeting.transcript ?? '',
              transcriptKey: transcriptKey(meeting.transcript),
            }}
          />
        </Surface>
      </div>
    </>
  );
}
