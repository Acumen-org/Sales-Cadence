'use client';

import { ActionForm, ActionButton } from '@/components/action-form';
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
    <div className="flex flex-wrap gap-4">{num('moveBatchLimit', 'Contacts per move (at most 50)', s.moveBatchLimit, 1, 50)}{num('undoDays', 'Undo window, days', s.undoDays, 1, 366)}{num('retentionInactiveDays', 'Remove after days without activity', s.retentionInactiveDays, 30, 3650)}{num('retentionUnworkedDays', 'Remove never-worked after days', s.retentionUnworkedDays, 30, 3650)}</div>
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

export function CallingSettingsForm({ c }: { c: CallingSettings }) {
  return <ActionForm action={saveCallingSettingsAction} className="flex flex-wrap items-end gap-4 p-4">
    <label className="block text-xs text-ink-500">Outside calling hours<select name="callingHours" defaultValue={c.callingHours} className="mt-1"><option value="block">Call is off</option><option value="warn">Ask first</option><option value="off">No check</option></select></label>
    {num('startHour', 'From (hour)', c.startHour, 0, 23)}{num('endHour', 'Until (hour)', c.endHour, 1, 24)}{num('connectSeconds', 'A connect before its form, seconds', c.connectSeconds, 1, 600)}{num('conversationSeconds', 'A conversation, seconds', c.conversationSeconds, 1, 3600)}
    <button type="submit" className="btn-primary btn-sm">Save</button>
  </ActionForm>;
}

export function ImportNowButton() {
  return <ActionButton action={async () => importCallsNowAction()} payload={{}} refresh>Import calls now</ActionButton>;
}

export function CallerNumberRow({ number, friendlyName, userId, suggestion, users }: { number: string; friendlyName: string; userId: string | null; suggestion: string | null; users: { id: string; name: string }[] }) {
  return <ActionForm action={setCallerNumberAction} className="flex flex-wrap items-center gap-2">
    <input type="hidden" name="number" value={number} />
    <span className="w-36 tabular-nums text-ink-900">{number}</span>
    <span className="w-56 truncate text-ink-500">{friendlyName}</span>
    <select name="userId" aria-label={`Rep for ${number}`} defaultValue={userId ?? suggestion ?? ''} className="!py-1 text-[13px]"><option value="">Nobody</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
    <button type="submit" className="btn-secondary btn-sm">{userId ? 'Save' : 'Confirm'}</button>
  </ActionForm>;
}

export function CleanupNowButton() {
  return <ActionButton action={async () => cleanupSandboxCrmNowAction()} payload={{}} refresh>Clean up now</ActionButton>;
}
