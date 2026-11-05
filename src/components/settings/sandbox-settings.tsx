'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ActionForm, ActionButton } from '@/components/action-form';
import { useConfirm } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui';
import { cleanupSandboxCrmNowAction, saveCallingSettingsAction, saveSandboxSettingsAction } from '@/lib/actions/settings';
import { addSuppressionAction } from '@/lib/actions/sandbox';
import { importCallsNowAction, setCallerNumberAction } from '@/lib/actions/call-forms';
import type { CallingSettings, SandboxSettings } from '@/lib/settings';

const check = (name: string, label: string, on: boolean) => <label className="inline-flex items-center gap-2 text-[13px] text-ink-700"><input type="checkbox" name={name} defaultChecked={on} />{label}</label>;
const num = (name: string, label: string, value: number, min: number, max: number) => <label className="block text-xs text-ink-500">{label}<input type="number" name={name} defaultValue={value} min={min} max={max} className="mt-1 w-28" /></label>;
const text = (name: string, label: string, value: string) => <label className="block text-xs text-ink-500">{label}<input name={name} defaultValue={value} className="mt-1 w-44" /></label>;

export function SandboxSettingsForm({ s }: { s: SandboxSettings }) {
  return <ActionForm action={saveSandboxSettingsAction} className="space-y-4 p-4">
    <div className="flex flex-wrap gap-5">{check('enabled', 'Bellwether may push into the sandbox', s.enabled)}{check('cleanupAutoCreated', 'Remove people Twenty creates from email or calendar for sandbox contacts', s.cleanupAutoCreated)}</div>
    <fieldset><legend className="mb-2 text-xs text-ink-500">Ready for CRM needs</legend><div className="flex flex-wrap gap-5">{check('requireFirm', 'A firm', s.requireFirm)}{check('requireEmailOrPhone', 'An email or a direct or mobile phone', s.requireEmailOrPhone)}{check('requireOwnerLogin', 'An owner with a Twenty login', s.requireOwnerLogin)}{check('requirePod', 'A pod', s.requirePod)}</div></fieldset>
    <fieldset><legend className="mb-2 text-xs text-ink-500">Move to CRM writes</legend><div className="flex flex-wrap gap-4">{text('leadSource', 'Lead source', s.leadSource)}{text('leadSourceFallback', 'Lead source if that option is missing', s.leadSourceFallback)}{text('contactType', 'Contact type', s.contactType.join(', '))}{text('listCategory', 'List category', s.listCategory)}{text('pipelineStage', 'Pipeline stage', s.pipelineStage)}</div></fieldset>
    <div className="flex flex-wrap gap-4">{num('moveBatchLimit', 'Contacts per move (at most 50)', s.moveBatchLimit, 1, 50)}{num('undoDays', 'Undo window, days (applies to new moves only; existing moves keep their deadline)', s.undoDays, 1, 366)}{num('retentionInactiveDays', 'Remove after days without activity', s.retentionInactiveDays, 30, 3650)}{num('retentionUnworkedDays', 'Remove never-worked after days', s.retentionUnworkedDays, 30, 3650)}</div>
    <div className="flex justify-end"><button type="submit" className="btn-primary btn-sm">Save</button></div>
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
  return <ActionButton action={async () => cleanupSandboxCrmNowAction()} payload={{}} refresh>Clean up now</ActionButton>;
}
