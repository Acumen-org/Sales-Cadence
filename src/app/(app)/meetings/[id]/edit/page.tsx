import { notFound, redirect } from 'next/navigation';
import { companiesInScope } from '@/lib/meetings-query';
import { requireUser } from '@/lib/auth/current-user';
import { ROLES_NEEDING_POD } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { canManageMeetingAction } from '@/lib/actions/meetings';
import { MeetingForm } from '@/components/meetings/meeting-form';
import { PageHeader, Surface } from '@/components/ui';
import { meetingDay } from '@/lib/meetings/day';

export default async function EditMeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [meeting, companies, fos] = await Promise.all([
    prisma.meeting.findUnique({ where: { id }, include: { attendees: true } }),
    companiesInScope(user),
    prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  if (!meeting) notFound();
  if (!(await canManageMeetingAction(id))) redirect(`/meetings/${id}`);

  return (
    <>
      <PageHeader title="Edit meeting" subtitle={meeting.title} />
      <div className="max-w-3xl px-6 pb-8 pt-3">
        <Surface>
          <MeetingForm
            mode="edit"
            companies={companies}
            fos={fos}
            initial={{
              id: meeting.id,
              bookedById: meeting.bookedById ?? '',
              title: meeting.title,
              sourceUrl: meeting.sourceUrl,
              occurredAt: meetingDay(meeting.occurredAt),
              companyId: meeting.companyId ?? '',
              attendees: meeting.attendees.map((a) => ({ name: a.name, email: a.email, personId: a.personId, userId: a.userId })),
              products: meeting.products,
              transcript: meeting.transcript ?? '',
            }}
          />
        </Surface>
      </div>
    </>
  );
}
