'use client';

import type { Settings } from '@/lib/settings';
import { saveMatchingSettingsAction, saveRulesSettingsAction, saveSyncSettingsAction, saveTwentySettingsAction } from '@/lib/actions/settings';
import { ActionForm } from '@/components/action-form';
import { Card, Field } from '@/components/ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Check({ name, label, checked, hint }: { name: string; label: string; checked: boolean; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm font-normal text-slate-700">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-0.5 h-4 w-4 rounded" />
      <span>
        {label}
        {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
      </span>
    </label>
  );
}

export function TwentyConnectionForm({ twenty, hasEnvKey, defaultSchemaJson }: { twenty: Settings['twenty']; hasEnvKey: boolean; defaultSchemaJson: string }) {
  return (
    <Card title="Connection and schema mapping">
      <ActionForm action={saveTwentySettingsAction} className="space-y-4 p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Twenty base URL" hint="Overrides TWENTY_API_URL. No trailing slash. Also used for Open in Twenty links.">
            <input name="baseUrl" defaultValue={twenty.baseUrl ?? ''} className="w-full" placeholder="https://twenty.example.com" />
          </Field>
          <Field label="API key" hint={twenty.apiKey ? 'A key is stored in settings. Leave blank to keep it.' : hasEnvKey ? 'Using TWENTY_API_KEY from the environment. Enter a key here to override.' : 'No key configured.'}>
            <input name="apiKey" type="password" autoComplete="off" className="w-full" placeholder={twenty.apiKey ? '(unchanged)' : ''} />
            {twenty.apiKey ? <Check name="clearApiKey" label="Remove the stored key (fall back to the environment)" checked={false} /> : null}
          </Field>
        </div>
        <Field label="Field mapping overrides (JSON)" hint={'Only the names that differ from the defaults, e.g. {"person": {"owner": "accountOwner", "ownerId": "accountOwnerId"}}. Defaults are shown below for reference.'}>
          <textarea name="schema" rows={6} defaultValue={twenty.schema ? JSON.stringify(twenty.schema, null, 2) : ''} className="w-full font-mono text-xs" />
        </Field>
        <details>
          <summary className="cursor-pointer text-xs text-slate-500">Default mapping (twenty-schema.ts)</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-3 text-[11px] text-slate-700">{defaultSchemaJson}</pre>
        </details>
        <button type="submit" className="btn-primary">
          Save Twenty settings
        </button>
      </ActionForm>
    </Card>
  );
}

export function MatchingForm({ matching }: { matching: Settings['matching'] }) {
  return (
    <Card title="Note title patterns (regular expressions, case-insensitive)">
      <ActionForm action={saveMatchingSettingsAction} className="space-y-4 p-4">
        <Field label="Outbound email note" hint="Optional named group (?<actor>...) captures who sent it.">
          <input name="outboundEmailTitle" defaultValue={matching.outboundEmailTitle} className="w-full font-mono text-xs" />
        </Field>
        <Field label="Outbound call note">
          <input name="outboundCallTitle" defaultValue={matching.outboundCallTitle} className="w-full font-mono text-xs" />
        </Field>
        <Field label="Call notes" hint="Named group (?<date>...) is informational.">
          <input name="callNotesTitle" defaultValue={matching.callNotesTitle} className="w-full font-mono text-xs" />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Prefix of notes Cadence writes" hint="Notes starting with this are never treated as evidence.">
            <input name="cadencePrefix" defaultValue={matching.cadencePrefix} className="w-full" />
          </Field>
          <Field label="Evidence grace (days)" hint="Activity older than the enrollment by more than this is a touch, not a completion.">
            <input name="evidenceGraceDays" type="number" min={0} max={30} defaultValue={matching.evidenceGraceDays} className="w-32" />
          </Field>
        </div>
        <Check name="callNotesCompleteCall" label="A Call Notes [...] note completes a pending call action" checked={matching.callNotesCompleteCall} />
        <button type="submit" className="btn-primary">
          Save matching rules
        </button>
      </ActionForm>
    </Card>
  );
}

export function RulesForm({ rules }: { rules: Settings['rules'] }) {
  return (
    <Card title="Caps, clock and working days">
      <ActionForm action={saveRulesSettingsAction} className="space-y-4 p-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Daily cap (actions per FO per day)" hint="Per-user overrides live in Users and pods.">
            <input name="dailyCap" type="number" min={1} max={500} defaultValue={rules.dailyCap} className="w-32" />
          </Field>
          <Field label="Clock mode">
            <select name="clockMode" defaultValue={rules.clockMode} className="w-full">
              <option value="shift">Shift: a late step pushes later steps by the same delay</option>
              <option value="hold">Hold to plan: later steps keep their planned dates</option>
            </select>
          </Field>
          <Field label="Default daily ramp per FO (new campaigns)">
            <input name="defaultDailyRampPerFo" type="number" min={1} defaultValue={rules.defaultDailyRampPerFo} className="w-32" />
          </Field>
        </div>
        <div>
          <label className="mb-1 block">Working days</label>
          <div className="flex flex-wrap gap-3">
            {DAYS.map((d, i) => (
              <label key={d} className="inline-flex items-center gap-1.5 text-sm font-normal text-slate-700">
                <input type="checkbox" name="workingDays" value={i} defaultChecked={rules.workingDays.includes(i)} className="h-4 w-4 rounded" /> {d}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Stalled after (days without a touch)">
            <input name="stalledDays" type="number" min={1} defaultValue={rules.stalledDays} className="w-32" />
          </Field>
          <Field label="Reconcile lookback (days)">
            <input name="reconcileLookbackDays" type="number" min={1} max={90} defaultValue={rules.reconcileLookbackDays} className="w-32" />
          </Field>
          <Field label="statusOfMeeting values that mean booked" hint="Comma separated, case-insensitive.">
            <input name="meetingStatusValues" defaultValue={rules.meetingStatusValues.join(', ')} className="w-full" />
          </Field>
        </div>
        <div className="space-y-2">
          <Check name="companyReplyPausesColleagues" label="A reply from anyone at a company pauses colleagues at that company" checked={rules.companyReplyPausesColleagues} />
          <Check name="meetingOnOpportunityCreated" label="An Opportunity created for a person marks a meeting" checked={rules.meetingOnOpportunityCreated} />
          <Check name="meetingOnStatusOfMeeting" label="person.statusOfMeeting set to a booked value marks a meeting" checked={rules.meetingOnStatusOfMeeting} />
        </div>
        <button type="submit" className="btn-primary">
          Save rules
        </button>
      </ActionForm>
    </Card>
  );
}

export function SyncForm({ sync }: { sync: Settings['sync'] }) {
  return (
    <Card title="Sync out to Twenty">
      <ActionForm action={saveSyncSettingsAction} className="space-y-3 p-4">
        <Check name="writeCompletionNotes" label="Write a [Cadence] note on the person for every completed action" checked={sync.writeCompletionNotes} hint="e.g. [Cadence] Email 2 sent by Alisa" />
        <Check name="mirrorOpenTasks" label="Mirror open Cadence tasks as Twenty Tasks (assigned to the FO, due on the task day)" checked={sync.mirrorOpenTasks} />
        <Check name="deleteMirroredTaskOnSkip" label="Delete the mirrored Twenty task when a Cadence task is skipped or cancelled (otherwise mark it done)" checked={sync.deleteMirroredTaskOnSkip} />
        <Check name="writeCadenceTaskIdField" label="Write the Cadence task id into the optional Task.cadenceTaskId field" checked={sync.writeCadenceTaskIdField} hint="Requires the custom field on Task in Twenty." />
        <button type="submit" className="btn-primary">
          Save sync settings
        </button>
      </ActionForm>
    </Card>
  );
}
