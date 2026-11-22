'use client';

import { ActionButton, ActionForm } from '@/components/action-form';
import { Field } from '@/components/ui';
import { Check } from '@/components/settings/settings-forms';
import { saveEmailSettingsAction, saveMeetingsSettingsAction } from '@/lib/actions/settings';
import { sendTestEmailAction } from '@/lib/actions/bell-email';
import type { EmailSettings, MeetingsSettings } from '@/lib/settings';

/** The company's monthly meeting target, the same for every FO (owner, 21 Nov 2026). */
export function MeetingsSettingsForm({ m }: { m: MeetingsSettings }) {
  return <ActionForm action={saveMeetingsSettingsAction} className="space-y-3 p-4">
    <Field label="Meetings each FO aims to book in a month" hint="Shown on Meetings as each person's progress ring. Only approved or recorded meetings count.">
      <input type="number" name="monthlyGoal" min={1} max={200} defaultValue={m.monthlyGoal} className="!w-28" />
    </Field>
    <div className="flex justify-end"><button type="submit" className="btn-primary btn-sm">Save</button></div>
  </ActionForm>;
}

const hours = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const hourLabel = (h: number) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 1, h)));
const hourSelect = (name: string, value: number, from: number, to: number) => <select name={name} defaultValue={value} className="!w-28">{hours(from, to).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select>;

/**
 * The bell by email (owner, 21 Nov 2026). Off until IT has given the Microsoft app Mail.Send for the
 * sender mailbox only; then an admin names the mailbox, sends a test, and turns it on.
 */
export function EmailSettingsForm({ s }: { s: EmailSettings }) {
  return <ActionForm action={saveEmailSettingsAction} className="space-y-4 p-4">
    <p className="text-[12.5px] text-ink-600">Each teammate gets only what is in their own bell, and chooses for themselves: what needs them plus a morning summary (the default), the summary only, or nothing. Times are in each person&apos;s own time zone.</p>
    <Check name="enabled" label="Email teammates their notifications" checked={s.enabled} />
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Send from this mailbox" hint="A Microsoft 365 mailbox, such as cadence@yourcompany.com. IT grants the app Mail.Send for this mailbox only.">
        <input type="email" name="senderMailbox" defaultValue={s.senderMailbox} placeholder="cadence@yourcompany.com" className="w-full" />
      </Field>
      <Field label="Something that needs action is emailed after (minutes)" hint="Unless it was read in Cadence by then.">
        <input type="number" name="urgentDelayMinutes" min={2} max={120} defaultValue={s.urgentDelayMinutes} className="!w-28" />
      </Field>
      <Field label="Work hours for those emails"><span className="flex items-center gap-2 text-[12.5px] text-ink-600">{hourSelect('workStartHour', s.workStartHour, 5, 12)} to {hourSelect('workEndHour', s.workEndHour, 13, 23)}, weekdays</span></Field>
      <Field label="Morning summary at">{hourSelect('digestHour', s.digestHour, 5, 11)}</Field>
    </div>
    <div className="flex justify-end"><button type="submit" className="btn-primary btn-sm">Save</button></div>
  </ActionForm>;
}

export function SendTestEmailButton() {
  return <ActionButton action={async () => sendTestEmailAction()} payload={{}} className="btn-secondary btn-sm">Send me a test</ActionButton>;
}
