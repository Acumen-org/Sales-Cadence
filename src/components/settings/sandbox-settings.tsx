'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ActionForm, ActionButton } from '@/components/action-form';
import { useConfirm } from '@/components/confirm-dialog';
import { Badge, Field } from '@/components/ui';
import { Check } from '@/components/settings/settings-forms';
import { SyncNowButton } from '@/components/settings/sync-now-button';
import { cleanupSandboxCrmNowAction, runCrmCheckNowAction, saveCallingSettingsAction, saveSandboxSettingsAction } from '@/lib/actions/settings';
import { addSuppressionAction } from '@/lib/actions/sandbox';
import { importCallsNowAction, setCallerNumberAction } from '@/lib/actions/call-forms';
import { optionLabel } from '@/lib/twenty/labels';
import type { CrmChoice, CrmValueChoices } from '@/lib/sandbox/cold-settings';
import type { CallingSettings, SandboxSettings } from '@/lib/settings';

const num = (name: string, label: string, value: number, min: number, max: number) => <label className="block text-xs text-ink-500">{label}<input type="number" name={name} defaultValue={value} min={min} max={max} className="mt-1 w-28" /></label>;

/** The field's options, plus a saved value the CRM no longer offers, named as such so it is picked again (B060). */
const withSaved = (options: CrmChoice[], saved: string[]): CrmChoice[] => [...options, ...saved.filter((v) => v && !options.some((o) => o.value === v)).map((value) => ({ value, label: `${optionLabel(value)} (not in the CRM)` }))];
const optionsOf = (list: CrmChoice[]) => list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>);

/**
 * Settings > Cold outreach, the rules (PLAN 4.7): what Bellwether may do, when a contact is ready to
 * move, and what Move to CRM writes on the person, picked from the CRM's own options by their names,
 * never typed (B060, B213). The undo window says it applies to new moves only (N062).
 */
export function ColdOutreachRulesForm({ s, choices }: { s: SandboxSettings; choices: CrmValueChoices }) {
  const f = choices.fields;
  return <ActionForm action={saveSandboxSettingsAction} className="space-y-5 p-4">
    <div className="space-y-2">
      <Check name="enabled" label="Bellwether may send contacts to Cold outreach" checked={s.enabled} />
      <Check name="cleanupAutoCreated" label="Remove the people the CRM makes from an email or a calendar invite for a cold contact, when nobody has worked them" checked={s.cleanupAutoCreated} />
    </div>
    <fieldset>
      <legend className="mb-2 text-[12px] font-medium text-ink-500">A contact can move to the CRM when it has</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Check name="requireFirm" label="A firm" checked={s.requireFirm} />
        <Check name="requireEmailOrPhone" label="An email, or a direct or mobile phone" checked={s.requireEmailOrPhone} />
        <Check name="requireOwnerLogin" label="An owner with a CRM login" checked={s.requireOwnerLogin} />
        <Check name="requirePod" label="A pod" checked={s.requirePod} />
      </div>
    </fieldset>
    <fieldset className="space-y-3">
      <legend className="mb-1 text-[12px] font-medium text-ink-500">Move to CRM writes on the person</legend>
      {choices.why ? <p className="text-[12.5px] text-ink-600">{choices.why}, so these lists hold the values Cadence knows. Saving checks them again.</p> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Lead source"><select name="leadSource" defaultValue={s.leadSource}>{optionsOf(withSaved(f.leadSource.options, [s.leadSource]))}</select></Field>
        <Field label="Lead source if that option is missing"><select name="leadSourceFallback" defaultValue={s.leadSourceFallback}>{optionsOf(withSaved(f.leadSource.options, [s.leadSourceFallback]))}</select></Field>
        <Field label="List category"><select name="listCategory" defaultValue={s.listCategory}>{optionsOf(withSaved(f.listCategory.options, [s.listCategory]))}</select></Field>
        <Field label="Pipeline stage"><select name="pipelineStage" defaultValue={s.pipelineStage}>{optionsOf(withSaved(f.pipelineStage.options, [s.pipelineStage]))}</select></Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-[12px] font-medium text-ink-500">Contact type</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">{withSaved(f.contactType.options, s.contactType).map((o) => <Check key={o.value} name="contactType" value={o.value} label={o.label} checked={s.contactType.includes(o.value)} />)}</div>
      </fieldset>
    </fieldset>
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Contacts per move (at most 50)"><input type="number" name="moveBatchLimit" min={1} max={50} defaultValue={s.moveBatchLimit} className="!w-32" /></Field>
      <Field label="Undo window (days)" hint="Applies to new moves only; existing moves keep their deadline."><input type="number" name="undoDays" min={1} max={366} defaultValue={s.undoDays} className="!w-32" /></Field>
      <Field label="Remove a contact after this many days without activity"><input type="number" name="retentionInactiveDays" min={30} max={3650} defaultValue={s.retentionInactiveDays} className="!w-32" /></Field>
      <Field label="Remove a contact nobody worked after this many days"><input type="number" name="retentionUnworkedDays" min={30} max={3650} defaultValue={s.retentionUnworkedDays} className="!w-32" /></Field>
    </div>
    <button type="submit" className="btn-primary">Save Cold outreach settings</button>
  </ActionForm>;
}

export function SuppressionForm() {
  return <ActionForm action={addSuppressionAction} resetOnSuccess className="flex flex-wrap items-end gap-2 p-4">
    <label className="block text-xs text-ink-500">Kind<select name="kind" defaultValue="email" className="mt-1"><option value="email">Email</option><option value="phone">Phone</option><option value="linkedin">LinkedIn</option></select></label>
    <label className="block text-xs text-ink-500">Value<input name="value" required className="mt-1 w-72" /></label>
    <button type="submit" className="btn-secondary btn-sm">Add to the list</button>
  </ActionForm>;
}

/** B167: calling hours and the talk times, in plain words with their units. */
export function CallingSettingsForm({ c }: { c: CallingSettings }) {
  return <ActionForm action={saveCallingSettingsAction} className="space-y-4 p-4">
    <div className="flex flex-wrap items-end gap-4">
      <label className="block text-xs text-ink-500">Outside calling hours<select name="callingHours" defaultValue={c.callingHours} className="mt-1 !w-44"><option value="block">Call is off</option><option value="warn">Ask first</option><option value="off">No check</option></select></label>
      {num('startHour', 'Calls from (hour, the contact\'s time)', c.startHour, 0, 23)}{num('endHour', 'Calls until (hour, the contact\'s time)', c.endHour, 1, 24)}
    </div>
    <div className="flex flex-wrap items-end gap-4">
      {num('connectSeconds', 'Talk time that counts as a connect (seconds)', c.connectSeconds, 1, 600)}{num('conversationSeconds', 'Talk time that counts as a conversation (seconds)', c.conversationSeconds, 1, 3600)}
    </div>
    <p className="text-[12.5px] text-ink-600">Calling hours are checked on Cadence&apos;s Call button, in the contact&apos;s own time zone. From the connect time on, the post-call form does not accept No answer or Busy.</p>
    <div className="flex justify-end"><button type="submit" className="btn-primary btn-sm">Save</button></div>
  </ActionForm>;
}

export function ImportNowButton() {
  return <ActionButton action={async () => importCallsNowAction()} payload={{}} refresh>Import calls now</ActionButton>;
}

/**
 * One Twilio number and its rep, on one line (B167): who it is assigned to, apart from a suggestion
 * read from its name, which never looks like an assignment. Giving a rep a second number asks first,
 * naming the number they lose (B164). A number a removed rep held says so: "Was Karson (removed)" (N107).
 */
export function CallerNumberRow({ number, friendlyName, holder, suggestion, users, former = null }: { number: string; friendlyName: string; holder: { id: string; name: string } | null; suggestion: { id: string; name: string } | null; users: { id: string; name: string; number: string | null }[]; former?: string | null }) {
  const [to, setTo] = useState(holder?.id ?? '');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [ask, dialog] = useConfirm();
  const router = useRouter();
  const save = async () => {
    const rep = users.find((u) => u.id === to);
    if (rep?.number && rep.number !== number && !(await ask({ title: `Give ${number} to ${rep.name}?`, effects: [`This moves ${rep.name} off ${rep.number}: a rep has one calling number.`, 'Calls on it count for them from now on; earlier calls keep their rep.'], confirmLabel: 'Assign' }))) return;
    if (!to && holder && !(await ask({ title: `Take ${number} from ${holder.name}?`, effects: ['Calls on it count for nobody until it is assigned again.'], confirmLabel: 'Clear' }))) return;
    const fd = new FormData();
    fd.set('number', number);
    fd.set('userId', to);
    start(async () => { const r = await setCallerNumberAction(fd); setResult(r.ok ? { ok: true, text: r.message ?? 'Saved.' } : { ok: false, text: r.error }); if (r.ok) router.refresh(); });
  };
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5">
    {dialog}
    <span className="w-36 shrink-0 tabular-nums text-ink-900">{number}</span>
    <span className="w-48 shrink-0 truncate text-ink-500" title={friendlyName}>{friendlyName}</span>
    <span className="w-56 shrink-0">{holder ? <Badge tone="green">Assigned to {holder.name}</Badge> : suggestion ? <Badge tone="amber">{`Suggested: ${suggestion.name}, not assigned`}</Badge> : <Badge>Not assigned</Badge>}</span>
    <select aria-label={`Rep for ${number}`} value={to} onChange={(e) => setTo(e.target.value)} className="!w-44 !py-1 text-[13px]"><option value="">Nobody</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
    <button type="button" className="btn-secondary btn-sm" disabled={pending || to === (holder?.id ?? '')} onClick={() => { void save(); }}>{to ? 'Assign' : 'Clear'}</button>
    {former ? <span className="text-[12px] text-amber-800">Was {former}</span> : null}
    {result ? <span role="status" className={`text-[12px] ${result.ok ? 'text-emerald-700' : 'text-red-700'}`}>{result.text}</span> : null}
  </div>;
}

export function CleanupNowButton() {
  return <SyncNowButton action={cleanupSandboxCrmNowAction} label="Clean up now" failed="The cleanup failed. Please try again." className="btn-secondary btn-sm" />;
}

/** The nightly CRM check, now (B168). */
export function CrmCheckNowButton() {
  return <SyncNowButton action={runCrmCheckNowAction} label="Run now" failed="The CRM check failed. Please try again." className="btn-secondary btn-sm" />;
}
