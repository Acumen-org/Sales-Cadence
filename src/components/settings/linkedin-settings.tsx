'use client';

import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/ui';
import { Check } from '@/components/settings/settings-forms';
import { saveLinkedInSettingsAction } from '@/lib/actions/settings';
import type { LinkedInSettings } from '@/lib/settings';

/**
 * Settings > LinkedIn, the rules: when Cadence asks a teammate to withdraw a request, send it again or
 * write after an acceptance, and when it warns that an account is sending too many requests. The ranges
 * match LinkedInSettingsSchema; the server checks them again.
 */
export function LinkedInRulesForm({ s }: { s: LinkedInSettings }) {
  return <ActionForm action={saveLinkedInSettingsAction} className="space-y-5 p-4">
    <Check name="enabled" label="Close and open tasks from what the LinkedIn Console reports" checked={s.enabled} />
    <p className="-mt-3 pl-6 text-[11.5px] leading-relaxed text-ink-500">When this is off, Cadence still keeps what the Console sends, but closes and opens nothing from it.</p>
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Withdraw a request after (days)" hint="A request still waiting after this many days gets a &quot;Withdraw the connection request&quot; task. 7 to 90.">
        <input type="number" name="withdrawAfterDays" min={7} max={90} step={1} defaultValue={s.withdrawAfterDays} className="!w-32" />
      </Field>
      <Field label="Send it again after (days)" hint="LinkedIn makes you wait about three weeks after a withdrawal. A new request task opens this many days after it. 21 to 90.">
        <input type="number" name="resendAfterDays" min={21} max={90} step={1} defaultValue={s.resendAfterDays} className="!w-32" />
      </Field>
      <Field label="Times to send again" hint="How many times a withdrawn request is sent again before Cadence stops asking. 0 means never. 0 to 3.">
        <input type="number" name="maxResends" min={0} max={3} step={1} defaultValue={s.maxResends} className="!w-32" />
      </Field>
      <Field label="Message after acceptance (working days)" hint="When someone accepts, a task to write to them opens this many working days later. 0 means the same day. 0 to 10.">
        <input type="number" name="messageAfterAcceptDays" min={0} max={10} step={1} defaultValue={s.messageAfterAcceptDays} className="!w-32" />
      </Field>
      <Field label="Requests per account per week" hint="Cadence warns when an account sends this many requests in 7 days. LinkedIn's own limit is about 100. An account can have its own limit in the Console. 10 to 200.">
        <input type="number" name="inviteWeeklyLimit" min={10} max={200} step={1} defaultValue={s.inviteWeeklyLimit} className="!w-32" />
      </Field>
    </div>
    <button type="submit" className="btn-primary">Save LinkedIn settings</button>
  </ActionForm>;
}
