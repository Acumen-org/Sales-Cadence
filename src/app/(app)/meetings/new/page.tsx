import { requireUser } from '@/lib/auth/current-user';
import { companiesInScope } from '@/lib/meetings-query';
import { prisma } from '@/lib/db';
import { MeetingForm } from '@/components/meetings/meeting-form';
import { PageHeader, Surface } from '@/components/ui';
import { dateTimeInputValue } from '@/lib/dates';

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in the viewer's own clock. */

/**
 * `personId` pre-fills this form from a recording Twenty already holds: the link, the account and
 * the attendee come from the person record, so adding one is a single click from the Meetings
 * list or the person's panel. The FO still says when it happened and pastes the transcript.
 */
export default async function NewMeetingPage({ searchParams }: { searchParams: Promise<{ account?: string; personId?: string; url?: string }> }) {
  const user = await requireUser();
  const { account, personId, url } = await searchParams;
  const [companies, person] = await Promise.all([
    companiesInScope(user),
    personId ? prisma.personCache.findUnique({ where: { id: personId } }) : Promise.resolve(null),
  ]);
  const personName = person ? [person.firstName, person.lastName].filter(Boolean).join(' ').trim() : '';

  return (
    <>
      <PageHeader title="Add a meeting" />
      <div className="max-w-4xl px-6 pb-8 pt-2">
        <Surface>
          <MeetingForm
            mode="create"
            timezone={user.timezone}
            companies={companies}
            initial={{
              title: person ? `Meeting - ${personName}${person.companyName ? ` (${person.companyName})` : ''}` : '',
              sourceUrl: url ?? person?.recordingUrl ?? person?.meetingUrl ?? '',
              occurredAt: dateTimeInputValue(new Date(), user.timezone),
              durationMin: '',
              companyId: account ?? person?.companyId ?? '',
              attendees: [{ userId: user.id, name: user.name, email: user.email }, ...(person ? [{ personId: person.id, name: personName, email: person.email }] : [])],
              products: [],
              transcript: '',
            }}
          />
        </Surface>
      </div>
    </>
  );
}
