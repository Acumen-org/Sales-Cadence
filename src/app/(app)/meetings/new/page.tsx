import { requireUser } from '@/lib/auth/current-user';
import { canCreateMeeting, needsPod, ROLES_NEEDING_POD } from '@/lib/auth/rbac';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { MeetingForm } from '@/components/meetings/meeting-form';
import { PageHeader, Surface } from '@/components/ui';
import { meetingDay } from '@/lib/meetings/day';
import { prospectOptions, teamOptions } from '@/lib/meetings/people-search';

/**
 * `personId` pre-fills this form from a recording Twenty already holds: the link and the prospect
 * come from the person record, so adding one is a single click from the person's panel. Whoever
 * adds it starts on the team list, and as the FO who booked it when they are one.
 */
export default async function NewMeetingPage({ searchParams }: { searchParams: Promise<{ personId?: string; url?: string }> }) {
  const user = await requireUser();
  if (!canCreateMeeting(user)) redirect('/meetings');
  const { personId, url } = await searchParams;
  const [person, fos, team, prospects] = await Promise.all([
    personId ? prisma.personCache.findUnique({ where: { id: personId } }) : Promise.resolve(null),
    prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    teamOptions([user.id]),
    personId ? prospectOptions([personId]) : Promise.resolve([]),
  ]);
  const personName = person ? [person.firstName, person.lastName].filter(Boolean).join(' ').trim() : '';

  return (
    <>
      <PageHeader title="Add a meeting" />
      <div className="max-w-4xl px-6 pb-8 pt-2">
        <Surface>
          <MeetingForm
            mode="create"
            fos={fos}
            initial={{
              bookedById: needsPod(user.role) ? user.id : '',
              title: person ? `Meeting - ${personName}${person.companyName ? ` (${person.companyName})` : ''}` : '',
              sourceUrl: url ?? person?.recordingUrl ?? person?.meetingUrl ?? '',
              occurredAt: meetingDay(new Date()),
              team,
              prospects,
              products: [],
              transcript: '',
            }}
          />
        </Surface>
      </div>
    </>
  );
}
