import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { MeetingForm } from '@/components/meetings/meeting-form';
import { PageHeader, Surface } from '@/components/ui';

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in the viewer's own clock. */
function nowLocalValue(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export default async function NewMeetingPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requireUser();
  const { account } = await searchParams;
  const companies = await prisma.companyCache.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 });

  return (
    <>
      <PageHeader title="Add a meeting" subtitle="Paste the recording link, and the transcript if you have it. Analysis can be run afterwards." />
      <div className="max-w-3xl px-6 pb-8 pt-3">
        <Surface>
          <MeetingForm
            mode="create"
            companies={companies}
            initial={{
              title: '',
              sourceUrl: '',
              occurredAt: nowLocalValue(user.timezone),
              durationMin: '',
              companyId: account ?? '',
              attendees: '',
              notes: '',
              transcript: '',
            }}
          />
        </Surface>
      </div>
    </>
  );
}
