import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { ROLES_NEEDING_POD } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { canManageMeetingAction } from '@/lib/actions/meetings';
import { MeetingForm } from '@/components/meetings/meeting-form';
import { PageHeader, Surface } from '@/components/ui';
import { meetingDay } from '@/lib/meetings/day';
import { prospectOptions, teamOptions } from '@/lib/meetings/people-search';

export default async function EditMeetingPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
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

  return (
    <>
      <PageHeader title="Edit meeting" subtitle={meeting.title} />
      <div className="max-w-4xl px-6 pb-8 pt-2">
        <Surface>
          <MeetingForm
            mode="edit"
            fos={fos}
            initial={{
              id: meeting.id,
              bookedById: meeting.bookedById ?? '',
              title: meeting.title,
              sourceUrl: meeting.sourceUrl,
              embedUrl: meeting.embedUrl,
              mediaUrl: meeting.mediaUrl,
              occurredAt: meetingDay(meeting.occurredAt),
              team,
              prospects,
              products: meeting.products,
              transcript: meeting.transcript ?? '',
            }}
          />
        </Surface>
      </div>
    </>
  );
}
