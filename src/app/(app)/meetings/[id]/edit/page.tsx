import { notFound, redirect } from 'next/navigation';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { MeetingForm } from '@/components/meetings/meeting-form';
import { PageHeader, Surface } from '@/components/ui';

/** Render an instant as the `datetime-local` value for the viewer's clock. */
function localValue(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export default async function EditMeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [meeting, companies] = await Promise.all([
    prisma.meeting.findUnique({ where: { id }, include: { attendees: true } }),
    prisma.companyCache.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
  ]);
  if (!meeting) notFound();
  if (meeting.createdById !== user.id && !isAdmin(toActor(user))) redirect(`/meetings/${id}`);

  return (
    <>
      <PageHeader title="Edit meeting" subtitle={meeting.title} />
      <div className="max-w-3xl px-6 pb-8 pt-3">
        <Surface>
          <MeetingForm
            mode="edit"
            companies={companies}
            initial={{
              id: meeting.id,
              title: meeting.title,
              sourceUrl: meeting.sourceUrl,
              occurredAt: localValue(meeting.occurredAt, user.timezone),
              durationMin: meeting.durationSec ? Math.round(meeting.durationSec / 60) : '',
              companyId: meeting.companyId ?? '',
              attendees: meeting.attendees.map((a) => (a.name && a.email ? `${a.name} <${a.email}>` : a.email ?? a.name ?? '')).filter(Boolean).join('\n'),
              notes: meeting.notes ?? '',
              transcript: meeting.transcript ?? '',
            }}
          />
        </Surface>
      </div>
    </>
  );
}
