'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Modal } from '@/components/modal';
import { ConfirmDialog, useConfirm } from '@/components/confirm-dialog';
import { AddToCampaign } from '@/components/campaigns/add-to-campaign';
import { DateWithWorkingDayHint } from '@/components/tasks/working-day-hint';
import { assignContactsAction, claimContactsAction, removeContactsAction, setNextStepsAction } from '@/lib/actions/sandbox';
import type { ActionResult } from '@/lib/actions/users';
import { removeConfirm } from '@/lib/outreach/confirm-words';
import { flashHref, type BulkAct, type ColdTableRow } from '@/lib/sandbox/list-view';
import { MoveDialog } from './move-dialog';

export type ColdBulkOptions = {
  /** Who the reader may give contacts to: active sales reps of their pods (B119, B208). Empty: no Assign. */
  owners: { id: string; name: string; podIds: string[] }[];
  /** Pods the reader may put a contact in, for the Move dialog's fixes. */
  pods: { id: string; name: string }[];
  /** The reader's today and Settings > Rules' working days, for Set next step's date. */
  today: string;
  workingDays: number[];
};

const ACTION_NAMES: Record<BulkAct, string> = { claim: 'Claim', assign: 'Assign', enroll: 'Add to campaign', next_step: 'Set next step', move: 'Move to CRM', remove: 'Remove' };

/** "Move to CRM", or "Move 3 of 5 to CRM" when some selected contacts cannot be moved (B118, B151). */
function labelFor(act: BulkAct, k: number, n: number): string {
  if (k === n) return ACTION_NAMES[act];
  const part = `${k} of ${n}`;
  switch (act) {
    case 'enroll': return `Add ${part} to a campaign`;
    case 'next_step': return `Set next step for ${part}`;
    case 'move': return `Move ${part} to CRM`;
    default: return `${ACTION_NAMES[act]} ${part}`;
  }
}

/**
 * The bulk actions for selected cold contacts (PLAN 4.1): only those that fit at least one selected
 * contact, each saying how many it acts on and, in words, why the others are left out (B118, B151).
 * The server said what each row allows. Every result, refusals included, comes back as a message on
 * the list's address, so it survives the refresh (B148), and the list keeps its view and filters
 * (B192). Assign is a picker and an explicit Assign button that says the work moves too (N078).
 */
export function ColdBulkActions({ rows, owners, pods, today, workingDays, onDone }: ColdBulkOptions & { rows: ColdTableRow[]; onDone: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [dialog, setDialog] = useState<'assign' | 'next' | 'move' | null>(null);
  const [assignTo, setAssignTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ask, confirmDialog] = useConfirm();
  const n = rows.length;
  const fit = (act: BulkAct) => rows.filter((r) => r.allows[act] === true);
  const named = (list: ColdTableRow[]) => (list.length === 1 ? list[0].name : `${list.length} contacts`);

  const finish = (r: ActionResult) => {
    router.replace(flashHref(pathname, params.toString(), r), { scroll: false });
    router.refresh();
    onDone();
  };
  const send = (action: (fd: FormData) => Promise<ActionResult>, list: ColdTableRow[], extra: Record<string, string> = {}) => {
    const fd = new FormData();
    for (const r of list) fd.append('ids', r.id);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return action(fd);
  };
  const run = (action: (fd: FormData) => Promise<ActionResult>, list: ColdTableRow[], extra: Record<string, string> = {}) => start(async () => finish(await send(action, list, extra)));

  const claim = fit('claim');
  const assign = owners.length ? fit('assign') : [];
  const enroll = fit('enroll');
  const next = fit('next_step');
  const move = fit('move');
  const remove = fit('remove');
  const shown: [BulkAct, ColdTableRow[]][] = ([['claim', claim], ['assign', assign], ['enroll', enroll], ['next_step', next], ['move', move], ['remove', remove]] as [BulkAct, ColdTableRow[]][]).filter(([, list]) => list.length > 0);
  // Every action shown that leaves some selected contacts out says why, in words (B151).
  const notes = shown.filter(([, list]) => list.length < n).map(([act, list]) => {
    const why = [...new Set(rows.filter((r) => !list.includes(r)).map((r) => r.allows[act] as string))];
    return `${ACTION_NAMES[act]} leaves out ${n - list.length}: ${why.slice(0, 2).join('; ')}${why.length > 2 ? '; and more' : ''}.`;
  });
  const target = owners.find((o) => o.id === assignTo);
  const withWork = assign.filter((r) => r.hasWork).length;

  return <>
    {confirmDialog}
    {claim.length ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(claimContactsAction, claim)}>{labelFor('claim', claim.length, n)}</button> : null}
    {assign.length ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { setAssignTo(''); setDialog('assign'); }}>{labelFor('assign', assign.length, n)}</button> : null}
    {enroll.length ? <AddToCampaign personIds={enroll.map((r) => r.id)} audience="SANDBOX" className="btn-secondary btn-sm" label={labelFor('enroll', enroll.length, n)} alreadyIn={rows.filter((r) => r.allows.enroll === 'Already in a campaign').length} onDone={(m) => finish({ ok: true, message: m ?? 'Added to the campaign.' })} /> : null}
    {next.length ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { setError(null); setDialog('next'); }}>{labelFor('next_step', next.length, n)}</button> : null}
    {move.length ? <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={() => setDialog('move')}>{labelFor('move', move.length, n)}</button> : null}
    {remove.length ? <details className="relative">
      <summary className="btn-ghost btn-sm cursor-pointer list-none [&::-webkit-details-marker]:hidden">More</summary>
      <div className="absolute left-0 z-20 mt-1 min-w-[11rem] rounded-lg border border-line bg-white p-1 shadow-pop">
        <button type="button" className="w-full rounded-md px-3 py-1.5 text-left text-[13px] text-red-700 hover:bg-red-50" disabled={pending} onClick={async () => { const answer = await ask(removeConfirm(remove.length)); if (answer) run(removeContactsAction, remove, { reason: answer.reason }); }}>{labelFor('remove', remove.length, n)}</button>
      </div>
    </details> : null}
    {!shown.length ? <span className="text-brand-800/80">Nothing you can do to {n === 1 ? 'this contact' : 'these contacts'} from here.</span> : null}
    {notes.length ? <ul className="w-full space-y-0.5 text-[12px] text-ink-600">{notes.map((t) => <li key={t}>{t}</li>)}</ul> : null}

    {dialog === 'move' ? <MoveDialog ids={move.map((r) => r.id)} owners={owners} pods={pods} onClose={() => setDialog(null)} /> : null}
    {dialog === 'assign' ? <ConfirmDialog
      title={`Assign ${named(assign)}`}
      effects={[
        `${assign.length === 1 ? `${assign[0].name} becomes` : `They become`} ${target ? `${target.name}'s` : 'the contacts of the rep you choose'}.`,
        `Their open next steps and running campaigns go to ${target?.name ?? 'that rep'} with them${withWork ? ` (${withWork === assign.length ? (assign.length === 1 ? 'it has some' : 'each has some') : `${withWork} of them have some`})` : ''}.`,
      ]}
      confirmLabel="Assign"
      confirmDisabled={!assignTo}
      pending={pending}
      onCancel={() => setDialog(null)}
      // N076: each contact goes only if its owner is still the one shown here.
      onConfirm={() => { setDialog(null); run(assignContactsAction, assign, { userId: assignTo, ...Object.fromEntries(assign.map((r) => [`owner:${r.id}`, r.ownerId ?? ''])) }); }}
    >
      <label className="block text-xs text-ink-500">Give to<select className="mt-1 w-full" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}><option value="">Choose a rep</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
    </ConfirmDialog> : null}
    {dialog === 'next' ? <Modal label="Set next step" onClose={() => { if (!pending) setDialog(null); }} className="max-w-md">
      <form className="space-y-4 p-5" onInput={() => setError(null)} onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        start(async () => {
          const r = await send(setNextStepsAction, next, { label: String(form.get('label') ?? ''), action: String(form.get('action') ?? 'CALL'), dueDate: String(form.get('dueDate') ?? '') });
          // B203: a refusal stays in the dialog until something is changed; a result goes to the list.
          if (!r.ok) { setError(r.error); return; }
          setDialog(null);
          finish(r);
        });
      }}>
        <h2 className="text-base font-semibold text-ink-900">Set next step for {named(next)}</h2>
        <p className="text-[13px] text-ink-600">Each contact's owner does it. A contact with a next step already gets this one instead.</p>
        <label className="block text-xs text-ink-500">What<input name="label" required maxLength={200} data-autofocus placeholder="Intro call" className="mt-1 w-full" /></label>
        <label className="block text-xs text-ink-500">How<select name="action" defaultValue="CALL" className="mt-1 w-full"><option value="CALL">Call</option><option value="EMAIL">Email</option><option value="LINKEDIN_MESSAGE">LinkedIn message</option><option value="LINKEDIN_CONNECT">LinkedIn connect</option></select></label>
        <div className="text-xs text-ink-500">When<div className="mt-1"><DateWithWorkingDayHint name="dueDate" required min={today} defaultValue={today} workingDays={workingDays} label="When" className="w-full" /></div></div>
        {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={pending} onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Working' : 'Set next step'}</button>
        </div>
      </form>
    </Modal> : null}
  </>;
}
