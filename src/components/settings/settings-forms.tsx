'use client';

import { useState } from 'react';
import type { Settings } from '@/lib/settings';
import { saveMatchingSettingsAction, saveRulesSettingsAction, saveSyncSettingsAction, saveTwentySettingsAction } from '@/lib/actions/settings';
import { ActionForm } from '@/components/action-form';
import { Card, Field, Info } from '@/components/ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Check({ name, label, checked, info }: { name: string; label: string; checked: boolean; info?: string }) {
  return (
    <div className="flex items-start gap-2">
      <label className="flex items-start gap-2 text-sm font-normal text-ink-700">
        <input type="checkbox" name={name} defaultChecked={checked} className="mt-0.5 h-4 w-4 rounded" />
        <span>{label}</span>
      </label>
      {info ? <Info text={info} /> : null}
    </div>
  );
}

export function TwentyConnectionForm({ twenty, hasEnvKey, defaultSchemaJson }: { twenty: Settings['twenty']; hasEnvKey: boolean; defaultSchemaJson: string }) {
  return (
    <Card title="Connection and schema mapping">
      <ActionForm action={saveTwentySettingsAction} className="space-y-4 p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Twenty base URL" info="No trailing slash. Also used for the Open in Twenty links.">
            <input name="baseUrl" defaultValue={twenty.baseUrl ?? ''} className="w-full" placeholder="https://twenty.example.com" />
          </Field>
          <Field label="API key" hint={twenty.apiKey ? 'Stored · blank keeps it' : hasEnvKey ? 'From TWENTY_API_KEY · a key here overrides it' : 'Not configured'}>
            <input name="apiKey" type="password" autoComplete="off" className="w-full" placeholder={twenty.apiKey ? '(unchanged)' : ''} />
            {twenty.apiKey ? <Check name="clearApiKey" label="Remove the stored key (fall back to the environment)" checked={false} /> : null}
          </Field>
        </div>
        <Field label="Field mapping overrides (JSON)" hint={
            'Only the names that differ from the defaults, e.g. {"person": {"assignedToId": "relationshipOwnerId"}}. ' +
            'Select option values live under "personValues" and an override replaces that whole list, e.g. {"personValues": {"tier": ["A", "B"]}}. ' +
            'Defaults are shown below for reference.'
          }>
          <textarea name="schema" rows={6} defaultValue={twenty.schema ? JSON.stringify(twenty.schema, null, 2) : ''} className="w-full font-mono text-xs" />
        </Field>
        <details>
          <summary className="cursor-pointer text-xs text-ink-500">Default mapping (twenty-schema.ts)</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-canvas p-3 text-[11px] text-ink-700">{defaultSchemaJson}</pre>
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
        <Field label="Outbound email note" info="Optional named group (?<actor>...) captures who sent it.">
          <input name="outboundEmailTitle" defaultValue={matching.outboundEmailTitle} className="w-full font-mono text-xs" />
        </Field>
        <Field label="Outbound call note">
          <input name="outboundCallTitle" defaultValue={matching.outboundCallTitle} className="w-full font-mono text-xs" />
        </Field>
        <Field label="Call notes" info="Named group (?<date>...) is informational.">
          <input name="callNotesTitle" defaultValue={matching.callNotesTitle} className="w-full font-mono text-xs" />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Prefix of notes Cadence writes" info="Notes starting with this are never treated as evidence.">
            <input name="cadencePrefix" defaultValue={matching.cadencePrefix} className="w-full" />
          </Field>
          <Field label="Evidence grace (days)" info="Activity older than the enrollment by more than this is a touch, not a completion.">
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
          <Field label="Daily cap (actions per FO per day)">
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
              <label key={d} className="inline-flex items-center gap-1.5 text-sm font-normal text-ink-700">
                <input type="checkbox" name="workingDays" value={i} defaultChecked={rules.workingDays.includes(i)} className="h-4 w-4 rounded" /> {d}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Reconcile lookback (days)">
            <input name="reconcileLookbackDays" type="number" min={1} max={90} defaultValue={rules.reconcileLookbackDays} className="w-32" />
          </Field>
        </div>
        <Field label="Click-to-call endpoint" info="Blank uses the machine's own dialler.">
          <input name="clickToCallUrl" type="url" inputMode="url" defaultValue={rules.clickToCallUrl} placeholder="https://example.com/call" className="w-full" />
        </Field>
        <Field
          label="Our own email domains"
          info="Comma separated. A meeting counts as booked only when someone outside these domains attends. Subdomains are covered."
        >
          <input name="internalDomains" defaultValue={rules.internalDomains.join(', ')} className="w-full" />
        </Field>
        <div className="space-y-2">
          <Check name="companyReplyPausesColleagues" label="A reply from anyone at a company pauses colleagues at that company" checked={rules.companyReplyPausesColleagues} />
          <Check name="meetingOnOpportunityCreated" label="An Opportunity created for a person marks a meeting" checked={rules.meetingOnOpportunityCreated} />
          <Check name="exitOnBounce" label="A skip reason flagged as bounce ends the sequence (Bounced)" checked={rules.exitOnBounce} />
          <Check name="answeredCallIsReply" label="A call logged with an answered outcome counts as a reply and finishes the sequence" checked={rules.answeredCallIsReply} />
        </div>
        <DispositionsEditor initial={rules.callDispositions} />
        <SkipReasonsEditor initial={rules.skipReasons} />
        <button type="submit" className="btn-primary">
          Save rules
        </button>
      </ActionForm>
    </Card>
  );
}

type Disposition = Settings['rules']['callDispositions'][number];
type SkipReason = Settings['rules']['skipReasons'][number];
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'item';

/** Editable list of call outcomes; serialised as JSON for the server action. */
function DispositionsEditor({ initial }: { initial: Disposition[] }) {
  const [rows, setRows] = useState<Disposition[]>(initial);
  const update = (i: number, patch: Partial<Disposition>) => setRows((r) => r.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  return (
    <div>
      <input type="hidden" name="callDispositionsJson" value={JSON.stringify(rows)} />
      <label className="mb-1 block">Call outcomes (dispositions)</label>
      <table className="table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Key</th>
            <th>Answered</th>
            <th>Marks phone as bad</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => (
            <tr key={i}>
              <td>
                <input value={d.label} onChange={(e) => update(i, { label: e.target.value, key: rows[i].key || slug(e.target.value) })} className="w-full py-1 text-xs" />
              </td>
              <td>
                <input value={d.key} onChange={(e) => update(i, { key: slug(e.target.value) })} className="w-32 py-1 font-mono text-xs" />
              </td>
              <td>
                <input type="checkbox" checked={d.answered} onChange={(e) => update(i, { answered: e.target.checked })} className="h-4 w-4 rounded" />
              </td>
              <td>
                <input type="checkbox" checked={d.badPhone} onChange={(e) => update(i, { badPhone: e.target.checked })} className="h-4 w-4 rounded" />
              </td>
              <td className="text-right">
                <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))} disabled={rows.length <= 1}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => setRows((r) => [...r, { key: `outcome_${r.length + 1}`, label: 'New outcome', answered: false, badPhone: false }])}>
        Add outcome
      </button>
    </div>
  );
}

const EXIT_LABELS: Record<SkipReason['exit'], string> = {
  none: 'Keep in sequence',
  bounced: 'End: Bounced',
  not_interested: 'End: Not interested',
  opted_out: 'End: Opted out (never enrol again)',
  bad_data: 'End: Bad data',
};

/** Editable list of skip reasons with their consequence. */
function SkipReasonsEditor({ initial }: { initial: SkipReason[] }) {
  const [rows, setRows] = useState<SkipReason[]>(initial);
  const update = (i: number, patch: Partial<SkipReason>) => setRows((r) => r.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  return (
    <div>
      <input type="hidden" name="skipReasonsJson" value={JSON.stringify(rows)} />
      <label className="mb-1 block">Skip reasons</label>
      <table className="table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Key</th>
            <th>Consequence</th>
            <th>Bad email</th>
            <th>Bad phone</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input value={r.label} onChange={(e) => update(i, { label: e.target.value, key: rows[i].key || slug(e.target.value) })} className="w-full py-1 text-xs" />
              </td>
              <td>
                <input value={r.key} onChange={(e) => update(i, { key: slug(e.target.value) })} className="w-32 py-1 font-mono text-xs" />
              </td>
              <td>
                <select value={r.exit} onChange={(e) => update(i, { exit: e.target.value as SkipReason['exit'] })} className="py-1 text-xs">
                  {(Object.keys(EXIT_LABELS) as SkipReason['exit'][]).map((k) => (
                    <option key={k} value={k}>
                      {EXIT_LABELS[k]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input type="checkbox" checked={r.badEmail} onChange={(e) => update(i, { badEmail: e.target.checked })} className="h-4 w-4 rounded" />
              </td>
              <td>
                <input type="checkbox" checked={r.badPhone} onChange={(e) => update(i, { badPhone: e.target.checked })} className="h-4 w-4 rounded" />
              </td>
              <td className="text-right">
                <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => setRows((x) => x.filter((_, idx) => idx !== i))} disabled={rows.length <= 1}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => setRows((x) => [...x, { key: `reason_${x.length + 1}`, label: 'New reason', exit: 'none', badEmail: false, badPhone: false }])}>
        Add reason
      </button>
    </div>
  );
}

export function SyncForm({ sync }: { sync: Settings['sync'] }) {
  return (
    <Card title="Sync out to Twenty">
      <ActionForm action={saveSyncSettingsAction} className="space-y-3 p-4">
        <Check name="writeCompletionNotes" label="Write a [Cadence] note on the person for every completed action" checked={sync.writeCompletionNotes} />
        <Check name="mirrorOpenTasks" label="Mirror open Cadence tasks as Twenty Tasks (assigned to the FO, due on the task day)" checked={sync.mirrorOpenTasks} />
        <Check name="deleteMirroredTaskOnSkip" label="Delete the mirrored Twenty task when a Cadence task is skipped or cancelled (otherwise mark it done)" checked={sync.deleteMirroredTaskOnSkip} />
        <Check name="writeCadenceTaskIdField" label="Write the Cadence task id into the optional Task.cadenceTaskId field" checked={sync.writeCadenceTaskIdField} info="Requires the custom field on Task in Twenty." />
        <button type="submit" className="btn-primary">
          Save sync settings
        </button>
      </ActionForm>
    </Card>
  );
}
