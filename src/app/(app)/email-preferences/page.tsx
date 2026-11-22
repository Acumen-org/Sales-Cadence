import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { setEmailPreferenceAction } from '@/lib/actions/bell-email';
import { ActionForm } from '@/components/action-form';
import { PageFrame } from '@/components/page-frame';
import { Notice, Surface, ViewHeader } from '@/components/ui';

/**
 * How the bell emails you (owner, 21 Nov 2026). Everyone chooses for themselves; only what is in
 * their own bell is ever sent. Linked from every email and from the bell.
 */
export default async function EmailPreferencesPage() {
  const user = await requireUser();
  const [me, { email: s }] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { emailNotifications: true, email: true, timezone: true } }),
    getSettings(),
  ]);
  const hour = (h: number) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 1, h)));
  const choices = [
    { mode: 'smart', title: 'What needs me, plus a morning summary', body: `Approvals, replies, bounces and alerts arrive about ${s.urgentDelayMinutes} minutes after they ring, between ${hour(s.workStartHour)} and ${hour(s.workEndHour)} on weekdays, unless you already saw them in Cadence. Everything else comes in one summary at ${hour(s.digestHour)}.`, recommended: true },
    { mode: 'digest', title: 'Morning summary only', body: `One email at ${hour(s.digestHour)} on weekdays with what came in and what is waiting for you.` },
    { mode: 'off', title: 'No emails', body: 'Your bell in Cadence still shows everything.' },
  ];
  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title="Email from Cadence" />
        <div className="max-w-2xl space-y-4 px-5 pb-5">
          <p className="text-[13px] text-ink-600">Cadence can email you what rings your bell, so nothing waits for you to open the app. It sends to {me.email}, at the times below in your own time zone ({me.timezone.replace(/_/g, ' ')}), and only ever what is already in your bell.</p>
          {!s.enabled ? <Notice tone="info">Emails are not switched on for the workspace yet. Your choice is kept for when they are.</Notice> : null}
          <ActionForm action={setEmailPreferenceAction} className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="sr-only">How Cadence emails you</legend>
              {choices.map((c) => (
                <label key={c.mode} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-white p-3.5 transition-colors hover:border-brand-200 has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50/60">
                  <input type="radio" name="mode" value={c.mode} defaultChecked={me.emailNotifications === c.mode} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-medium text-ink-900">{c.title}{c.recommended ? <span className="ml-2 rounded-full bg-brand-100 px-1.5 text-[11px] font-medium text-brand-800">Recommended</span> : null}</span>
                    <span className="mt-0.5 block text-[12.5px] text-ink-600">{c.body}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <button type="submit" className="btn-primary">Save</button>
          </ActionForm>
        </div>
      </Surface>
    </PageFrame>
  );
}

export const dynamic = 'force-dynamic';
