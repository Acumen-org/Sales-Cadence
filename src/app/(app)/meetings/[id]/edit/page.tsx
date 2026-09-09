import { notFound, redirect } from 'next/navigation';
import { companiesInScope } from '@/lib/meetings-query';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { canManageMeetingAction } from '@/lib/actions/meetings';
import { MeetingForm } from '@/components/meetings/meeting-form';
import { PageHeader, Surface } from '@/components/ui';
import { dateTimeInputValue } from '@/lib/dates';

/** Render an instant as the `datetime-local` value for the viewer's clock. */

export default async function EditMeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [meeting, companies] = await Promise.all([
    prisma.meeting.findUnique({ where: { id }, include: { attendees: true } }),
    companiesInScope(user),
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
            timezone={user.timezone}
            companies={companies}
            initial={{
              id: meeting.id,
              title: meeting.title,
              sourceUrl: meeting.sourceUrl,
              occurredAt: dateTimeInputValue(meeting.occurredAt, user.timezone),
              durationMin: meeting.durationSec ? Math.round(meeting.durationSec / 60) : '',
              companyId: meeting.companyId ?? '',
              attendees: meeting.attendees.map((a) => ({ name: a.name, email: a.email, personId: a.personId, userId: a.userId })),
              transcript: meeting.transcript ?? '',
            }}
          />
        </Surface>
      </div>
    </>
  );
}
