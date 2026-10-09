'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { findPeopleForTaskAction, saveNextActionAction, type TaskPersonOption } from '@/lib/actions/next-actions';
import { Modal } from '@/components/modal';
import { IconClose, IconPlus, IconRefresh } from '@/components/icons';
import { Avatar } from '@/components/ui';
import { formatLocalDate } from '@/lib/dates';

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

/** Find the person a task is for: type a name, an email or a company. */
function PersonPicker({ chosen, onChoose }: { chosen: TaskPersonOption | null; onChoose: (p: TaskPersonOption | null) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<TaskPersonOption[]>([]);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [searching, start] = useTransition();
  const asked = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setFailed(false); return; }
    const n = ++asked.current;
    const t = setTimeout(() => start(async () => {
      try {
        const r = await findPeopleForTaskAction(term);
        if (n === asked.current) { setHits(r); setFailed(false); setActive(0); }
      } catch {
        if (n === asked.current) { setHits([]); setFailed(true); }
      }
    }), 220);
    return () => clearTimeout(t);
  }, [q]);
  const pickable = hits.filter((p) => !p.dnd);
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ(''); return; }
    if (!pickable.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % pickable.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + pickable.length) % pickable.length); }
    else if (e.key === 'Enter') { e.preventDefault(); onChoose(pickable[Math.min(active, pickable.length - 1)]); }
  };

  if (chosen) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
        <Avatar name={chosen.name} shape="circle" size={28} />
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink-900">{chosen.name}</span>{chosen.sub ? <span className="block truncate text-[12px] text-ink-500">{chosen.sub}</span> : null}</span>
        <button type="button" className="btn-ghost btn-sm" onClick={() => { onChoose(null); setQ(''); }}>Change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search by name, email or company" aria-label="Person" role="combobox" aria-expanded={hits.length > 0} aria-controls="task-person-results" aria-activedescendant={pickable[active] ? `task-person-${pickable[active].id}` : undefined} />
      {q.trim().length >= 2 ? (
        <ul id="task-person-results" role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-white py-1 shadow-lg">
          {hits.map((p) => (
            <li key={p.id} id={`task-person-${p.id}`} role="option" aria-selected={pickable[active]?.id === p.id}>
              <button type="button" tabIndex={-1} disabled={p.dnd} onClick={() => onChoose(p)} className={`flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-brand-50/60 disabled:cursor-not-allowed disabled:opacity-50 ${pickable[active]?.id === p.id ? 'bg-brand-50/70' : ''}`}>
                <Avatar name={p.name} shape="circle" size={26} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] text-ink-900">{p.name}</span>{p.sub ? <span className="block truncate text-[12px] text-ink-500">{p.sub}</span> : null}</span>
                {p.dnd ? <span className="shrink-0 text-[11.5px] text-red-700">Do not contact</span> : p.openTask ? <span className="shrink-0 text-[11.5px] text-ink-500">Has a task</span> : null}
              </button>
            </li>
          ))}
          {!hits.length ? <li className="px-3 py-2 text-[12.5px] text-ink-500">{searching ? 'Searching…' : failed ? 'Search failed. Try again.' : 'Nobody found'}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Create a task for one person or for everyone selected - or, opened from Tasks with nobody chosen
 * yet, for the person found in the search. It is written to the person's Next Action and Next
 * Action Due Date in Twenty, and shows up in Tasks on its day. A person has one open task at a
 * time (Twenty's fields hold one), so a new one replaces theirs.
 */
export function NextActionButton({ personIds, today, fos, canAssign, initial, label = 'Create task', className = 'btn-secondary btn-sm', onDone, existing, icon = 'refresh' }: {
  /** Who it is for; leave out to choose the person in the dialog. */
  personIds?: string[];
  today: string;
  /** Who it can be given to; empty for a junior FO, whose tasks are their own. */
  fos: { id: string; name: string }[];
  canAssign: boolean;
  initial?: NextActionDraft;
  label?: string;
  className?: string;
  onDone?: (message: string, created: { ids: string[]; dueDate: string }) => void;
  /** The open task this one would replace, for one person. */
  existing?: { label: string; dueDate: string } | null;
  icon?: 'refresh' | 'plus';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const fresh = () => initial ?? { label: '', action: 'EMAIL', dueDate: today, repeat: 'NONE', foUserId: '' };
  const [draft, setDraft] = useState<NextActionDraft>(fresh);
  const [person, setPerson] = useState<TaskPersonOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const picking = personIds === undefined;
  const ids = picking ? (person ? [person.id] : []) : personIds;
  const many = ids.length > 1;
  const replaces = picking ? person?.openTask ?? null : existing ?? null;

  const submit = () =>
    start(async () => {
      if (!ids.length) { setError('Choose who the task is for.'); return; }
      const fd = new FormData();
      fd.set('personIds', JSON.stringify(ids));
      for (const [k, v] of Object.entries(draft)) fd.set(k, v);
      let r: Awaited<ReturnType<typeof saveNextActionAction>>;
      try { r = await saveNextActionAction(fd); } catch { setError('The task could not be saved. Try again.'); return; }
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      setOpen(false);
      const created = { ids: ((r.data as { ids?: string[] } | undefined)?.ids) ?? [], dueDate: draft.dueDate };
      router.refresh();
      onDone?.(r.message ?? 'Task created.', created);
    });

  return (
    <>
      <button type="button" className={className} disabled={!picking && !personIds.length} onClick={() => { setDraft(fresh()); setPerson(null); setError(null); setOpen(true); }}>
        {icon === 'plus' ? <IconPlus size={14} /> : <IconRefresh size={13} />} {label}
      </button>
      {open ? (
        <Modal label="Create task" onClose={() => setOpen(false)}>
          <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">{many ? `Create a task for ${ids.length} people` : label === 'Change' ? 'Change task' : 'Create task'}</h2>
              <button type="button" aria-label="Close" className="btn-icon-ghost ml-auto" onClick={() => setOpen(false)}><IconClose size={16} /></button>
            </div>
            {picking ? <div className="space-y-1.5"><span className="text-[12px] font-medium text-ink-600">For</span><PersonPicker chosen={person} onChoose={setPerson} /></div> : null}
            <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">What to do</span>
              <input data-autofocus={picking ? undefined : true} required maxLength={200} value={draft.label} onChange={(e) => { setDraft({ ...draft, label: e.target.value }); setError(null); }} placeholder="Check in on the pilot" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">How</span>
                <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>{CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
              </label>
              <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">Due</span>
                <input type="date" required min={today} value={draft.dueDate} onChange={(e) => { setDraft({ ...draft, dueDate: e.target.value }); setError(null); }} />
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
            {replaces && !many ? <p className="rounded-lg bg-canvas px-3 py-2 text-[12.5px] text-ink-600">Replaces their open task: {replaces.label}, due {formatLocalDate(replaces.dueDate, 'long')}</p> : null}
            {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={pending || (picking && !person)}>{pending ? 'Saving…' : label === 'Change' ? 'Save task' : 'Create task'}</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
