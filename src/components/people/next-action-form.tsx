'use client';

import { useState, useTransition } from 'react';
import { saveNextActionAction } from '@/lib/actions/next-actions';
import { Modal } from '@/components/modal';
import { IconClose, IconRefresh } from '@/components/icons';

export type NextActionDraft = { label: string; action: string; dueDate: string; repeat: string; foUserId: string };

const CHANNELS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'CALL', label: 'Call' },
  { value: 'LINKEDIN_MESSAGE', label: 'LinkedIn message' },
  { value: 'LINKEDIN_CONNECT', label: 'LinkedIn connect' },
];
const REPEATS = [
  { value: 'NONE', label: 'Does not repeat' },
  { value: 'WEEKLY', label: 'Every week' },
  { value: 'BIWEEKLY', label: 'Every 2 weeks' },
  { value: 'MONTHLY', label: 'Every month' },
  { value: 'QUARTERLY', label: 'Every 3 months' },
];

/**
 * Set a next action for one person or for everyone selected. It is written to the person's Next
 * Action and Next Action Due Date in Twenty, and shows up in Tasks on its day.
 */
export function NextActionButton({ personIds, today, fos, canAssign, initial, label = 'Next action', className = 'btn-secondary btn-sm', onDone }: {
  personIds: string[];
  today: string;
  /** Who it can be given to; empty for a junior FO, whose next actions are their own. */
  fos: { id: string; name: string }[];
  canAssign: boolean;
  initial?: NextActionDraft;
  label?: string;
  className?: string;
  onDone?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NextActionDraft>(initial ?? { label: '', action: 'EMAIL', dueDate: today, repeat: 'NONE', foUserId: '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const many = personIds.length > 1;

  const submit = () =>
    start(async () => {
      const fd = new FormData();
      fd.set('personIds', JSON.stringify(personIds));
      for (const [k, v] of Object.entries(draft)) fd.set(k, v);
      const r = await saveNextActionAction(fd);
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      setOpen(false);
      // The action revalidates the pages this form lives on, and its answer carries them. A second
      // refresh on top raced the next click: a Stop right after saving never showed.
      onDone?.(r.message ?? 'Next action set.');
    });

  return (
    <>
      <button type="button" className={className} disabled={!personIds.length} onClick={() => { setDraft(initial ?? { label: '', action: 'EMAIL', dueDate: today, repeat: 'NONE', foUserId: '' }); setError(null); setOpen(true); }}>
        <IconRefresh size={13} /> {label}
      </button>
      {open ? (
        <Modal label="Next action" onClose={() => setOpen(false)}>
          <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">{many ? `Next action for ${personIds.length} people` : 'Next action'}</h2>
              <button type="button" aria-label="Close" className="btn-icon-ghost ml-auto" onClick={() => setOpen(false)}><IconClose size={16} /></button>
            </div>
            <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">What to do</span>
              <input autoFocus required maxLength={200} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Check in on the pilot" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">How</span>
                <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>{CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
              </label>
              <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">Due</span>
                <input type="date" required min={today} value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} />
              </label>
              <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">Repeats</span>
                <select value={draft.repeat} onChange={(e) => setDraft({ ...draft, repeat: e.target.value })}>{REPEATS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
              </label>
              {canAssign ? (
                <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">FO</span>
                  <select value={draft.foUserId} onChange={(e) => setDraft({ ...draft, foUserId: e.target.value })}>
                    <option value="">{many ? 'Each person’s own FO' : 'Their own FO'}</option>
                    {fos.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </label>
              ) : null}
            </div>
            {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Saving…' : 'Save next action'}</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
