'use client';
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACTION_LABELS, ACTION_TYPES, newStepId, StepsSchema, type ActionType, type SequenceStep, type StepAction } from '@/lib/sequences/steps';
import { ActionForm } from '@/components/action-form';
import type { ActionResult } from '@/lib/actions/users';
import { ActionIcon, IconArrowDown, IconArrowUp, IconLock, IconPlus, IconTrash } from '@/components/icons';
import { Field } from '@/components/ui';
import { RichTextEditor } from '@/components/rich-text-editor';

function blankAction(type: ActionType): StepAction { return { id: newStepId('act'), type, label: ACTION_LABELS[type], template: '', bodyHtml: '<p></p>' }; }
function htmlOf(a: StepAction) { return a.bodyHtml ?? '<p>' + (a.template ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>'; }

export function SequenceEditor({ sequenceId, initialSteps, action, submitLabel, header, lockedSteps = {}, readOnly = false, repeatEveryDays = null, durationDays = null }: {
  sequenceId?: string; initialSteps: SequenceStep[]; action: (data: FormData) => Promise<ActionResult>; submitLabel: string;
  header?: React.ReactNode; lockedSteps?: Record<string, number>; readOnly?: boolean; repeatEveryDays?: number | null; durationDays?: number | null;
}) {
  const router = useRouter();
  const [steps, setSteps] = useState(initialSteps);
  const [duration, setDuration] = useState<number | ''>(durationDays ?? (initialSteps.at(-1)?.day ?? 1));
  /** The step the day strip moves: the one last clicked or edited. */
  const [selected, setSelected] = useState<number | null>(null);
  // Reordering by pointer: the handle is pressed, the card follows the pointer's row, and the
  // release puts it there. HTML5 drag needed a data payload before Firefox would start at all,
  // and its drop target was the whole card, so a release between cards went nowhere.
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const startDrag = (from: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (locked(from)) return;
    e.preventDefault();
    setDragged(from);
    setOver(from);
    const onMove = (ev: PointerEvent) => {
      const mids = rows.current.map((el) => { const r = el?.getBoundingClientRect(); return r ? r.top + r.height / 2 : Number.POSITIVE_INFINITY; });
      let to = mids.findIndex((mid) => ev.clientY < mid);
      if (to === -1) to = steps.length - 1;
      setOver(to);
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const mids = rows.current.map((el) => { const r = el?.getBoundingClientRect(); return r ? r.top + r.height / 2 : Number.POSITIVE_INFINITY; });
      let to = mids.findIndex((mid) => ev.clientY < mid);
      if (to === -1) to = steps.length - 1;
      if (to !== from) move(from, to);
      setDragged(null);
      setOver(null);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
  const validation = useMemo(() => { const parsed = StepsSchema.safeParse(steps); return parsed.success ? null : parsed.error.issues.map(i => i.message).join(' · '); }, [steps]);
  const locked = (i: number) => readOnly || Boolean(lockedSteps[steps[i]?.id]);
  const update = (i: number, patch: Partial<SequenceStep>) => {
    if (locked(i)) return;
    // A day set from the strip has to stay between its neighbours, like the day box does.
    if (patch.day !== undefined) {
      const lo = i ? steps[i - 1].day + 1 : 1;
      const hi = steps[i + 1] ? steps[i + 1].day - 1 : (typeof duration === 'number' ? duration : 365);
      if (patch.day < lo || patch.day > hi) return;
    }
    setSteps(s => s.map((step, n) => n === i ? { ...step, ...patch } : step));
  };
  const changeAction = (i: number, j: number, patch: Partial<StepAction>) => update(i, { actions: steps[i].actions.map((a, n) => n === j ? { ...a, ...patch } : a) });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || steps.slice(Math.min(from, to), Math.max(from, to) + 1).some(s => lockedSteps[s.id]) || readOnly) return;
    const days = steps.map(s => s.day); const next = [...steps]; const [item] = next.splice(from, 1); next.splice(to, 0, item);
    setSteps(next.map((s, i) => ({ ...s, day: days[i] })));
  };
  const append = (type: ActionType) => setSteps(s => [...s, { id: newStepId(), day: (s.at(-1)?.day ?? -1) + 2, actions: [blankAction(type)] }]);
  return <ActionForm action={action} onSuccess={r => { if (r.redirectTo) router.push(r.redirectTo); router.refresh(); }} className="space-y-5">
    {sequenceId && <input type="hidden" name="sequenceId" value={sequenceId} />}
    <input type="hidden" name="steps" value={JSON.stringify(steps)} />
    {header}
    {/* The plan as a row of days: each step sits on its day; click a free day to move the step you
        last touched there. Weeks are marked because the start weekday is not known until a campaign
        picks it - what is fixed is the count of days. */}
    {typeof duration === 'number' && duration > 0 ? (
      <div className="surface px-5 py-4">
        <div className="mb-2 flex items-center justify-between text-[12px] text-ink-500">
          <span><span className="font-medium text-ink-900">{duration}</span> {Number(duration) === 1 ? 'day' : 'days'}</span>
          {selected !== null ? <span>Step <span className="font-medium text-ink-900">{selected + 1}</span> selected</span> : null}
        </div>
        <div className="grid gap-x-1 gap-y-4 pt-3" style={{ gridTemplateColumns: `repeat(${Math.min(duration, 14)}, minmax(0, 3.5rem))` }} role="listbox" aria-label="Days of the sequence">
          {Array.from({ length: duration }, (_, d) => d + 1).map((day) => {
            const at = steps.findIndex((st) => st.day === day);
            const weekStart = (day - 1) % 7 === 0;
            const busy = at !== -1;
            const canPlace = !readOnly && selected !== null && !locked(selected) && !busy;
            return (
              <button
                key={day}
                type="button"
                role="option"
                aria-selected={busy && at === selected}
                aria-label={busy ? `Day ${day}: step ${at + 1}` : `Day ${day}`}
                disabled={!busy && !canPlace}
                title={busy ? `Step ${at + 1}: ${steps[at].actions.map((a) => ACTION_LABELS[a.type]).join(' + ')}` : canPlace ? `Move step ${selected! + 1} to day ${day}` : undefined}
                onClick={() => { if (busy) setSelected(at); else if (canPlace) update(selected!, { day }); }}
                className={`relative flex h-9 flex-col items-center justify-center rounded-md border text-[11px] tabular-nums transition ${busy ? (at === selected ? 'border-brand-600 bg-brand-600 text-white' : 'border-brand-200 bg-brand-50 text-brand-800') : canPlace ? 'border-dashed border-line text-ink-400 hover:border-brand-300 hover:bg-brand-50/50' : 'border-line/60 text-ink-300'} ${weekStart ? 'ml-1' : ''}`}
              >
                <span className={busy ? 'font-medium' : undefined}>{day}</span>
                {weekStart ? <span className="absolute -top-3.5 left-0 text-[9px] uppercase tracking-wide text-ink-400">W{Math.floor((day - 1) / 7) + 1}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    ) : null}
    <ol className="space-y-0">
      {steps.map((step, i) => <li key={step.id} ref={(el) => { rows.current[i] = el; }} className={dragged !== null && over === i && dragged !== i ? (over < dragged ? 'border-t-2 border-brand-400' : 'border-b-2 border-brand-400') : dragged === i ? 'opacity-60' : undefined}>
        {i > 0 && <div className="ml-8 flex h-11 items-center border-l-2 border-brand-200 pl-5 text-xs text-ink-500">Wait <span className="mx-1 font-medium text-ink-900">{step.day - steps[i - 1].day}</span> {step.day - steps[i - 1].day === 1 ? 'day' : 'days'}</div>}
        <section className={`surface overflow-hidden ${selected === i ? 'ring-2 ring-brand-200' : ''}`} onFocusCapture={() => setSelected(i)} onPointerDownCapture={() => setSelected(i)}>
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-canvas/50 px-5 py-4">
            {!readOnly && <button type="button" aria-label={'Drag step ' + (i + 1)} title={locked(i) ? 'Work or cancel its open touches to move this step' : 'Drag to reorder'} disabled={locked(i)} onPointerDown={startDrag(i)} className={(dragged === i ? 'cursor-grabbing' : 'cursor-grab') + ' touch-none select-none px-1 text-lg text-ink-500 disabled:cursor-default'}>⠿</button>}
            <span className="rounded-lg bg-brand-900 px-3 py-2 text-sm font-semibold text-white">{i + 1}</span>
            <label className="flex items-center gap-2 text-xs text-ink-500">Day <input aria-label={'Step ' + (i + 1) + ' day'} type="number" min={i ? steps[i - 1].day + 1 : 1} max={steps[i + 1] ? steps[i + 1].day - 1 : (typeof duration === 'number' ? duration : 365)} value={step.day} onChange={e => update(i, { day: Number(e.target.value) })} disabled={locked(i)} className="!w-20" /></label>
            <div className="ml-auto flex items-center gap-1">
              {lockedSteps[step.id] ? <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-800" title="Work or cancel these before changing this step"><IconLock size={12} />Locked<span className="ml-1 font-normal text-amber-700">{lockedSteps[step.id]} open {lockedSteps[step.id] === 1 ? 'touch' : 'touches'}</span></span> : null}
              {!readOnly && <><button type="button" className="btn-ghost btn-sm" disabled={locked(i) || !i || locked(i - 1)} aria-label={'Move step ' + (i + 1) + ' up'} onClick={() => move(i, i - 1)}><IconArrowUp size={14} /></button><button type="button" className="btn-ghost btn-sm" disabled={locked(i) || i === steps.length - 1 || locked(i + 1)} aria-label={'Move step ' + (i + 1) + ' down'} onClick={() => move(i, i + 1)}><IconArrowDown size={14} /></button><button type="button" className="btn-ghost btn-sm" disabled={locked(i) || steps.length < 2 || steps.slice(i + 1).some(s => lockedSteps[s.id])} aria-label={'Remove step ' + (i + 1)} onClick={() => setSteps(s => s.filter(x => x.id !== step.id))}><IconTrash size={14} /></button></>}
            </div>
          </div>
          <div className="space-y-4 p-5">
            {step.actions.map((a, j) => <fieldset key={a.id} disabled={locked(i)} className="space-y-3 rounded-xl border border-line bg-canvas/30 p-4">
              <div className="flex items-center gap-2"><span className="rounded-lg bg-white p-2 text-brand-700"><ActionIcon action={a.type} size={19} /></span><strong className="text-sm">{ACTION_LABELS[a.type]}</strong>{!readOnly && step.actions.length > 1 && <button type="button" aria-label={'Remove ' + ACTION_LABELS[a.type] + ' module'} className="btn-ghost btn-sm ml-auto" onClick={() => update(i, { actions: step.actions.filter(x => x.id !== a.id) })}><IconTrash size={14} /></button>}</div>
              {a.type === 'EMAIL' && <Field label="Subject"><input aria-label={'Step ' + (i + 1) + ' email subject'} className="w-full !font-medium" value={a.subject ?? ''} onChange={e => changeAction(i, j, { subject: e.target.value })} /></Field>}
              <RichTextEditor value={htmlOf(a)} label={'Step ' + (i + 1) + ' ' + ACTION_LABELS[a.type]} disabled={locked(i)} onChange={(bodyHtml, template) => changeAction(i, j, { bodyHtml, template })} />
            </fieldset>)}
            {!locked(i) && <div className="flex flex-wrap items-center gap-2"><span className="mr-1 text-xs text-ink-500">Add to this step</span>{ACTION_TYPES.map(type => <button key={type} type="button" className="btn-secondary btn-sm" onClick={() => update(i, { actions: [...step.actions, blankAction(type)] })}><ActionIcon action={type} size={13} />{ACTION_LABELS[type]}</button>)}</div>}
          </div>
        </section>
      </li>)}
    </ol>
    {!readOnly && <><div className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed border-brand-300 bg-brand-50/40 p-5"><span className="mr-2 text-sm font-medium">New touchpoint</span>{ACTION_TYPES.map(type => <button key={type} type="button" className="btn-secondary" onClick={() => append(type)}><IconPlus size={13} /><ActionIcon action={type} size={14} />{ACTION_LABELS[type]}</button>)}</div>
      {/* The bar floats over the page, so the page reserves its height rather than hiding a card behind it. */}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-4 rounded-xl border border-line bg-white p-3 shadow-lg">{validation && <p role="alert" className="mr-auto text-sm font-medium text-red-700">{validation}</p>}<span className="text-[12px] text-ink-500"><span className="font-medium text-ink-900">{steps.length}</span> {steps.length === 1 ? 'touchpoint' : 'touchpoints'}, last on day <span className="font-medium text-ink-900">{(steps.at(-1)?.day ?? 1)}</span></span><label className="flex items-center gap-2 text-[12px] text-ink-500">Spans<span className="text-red-600" aria-hidden>*</span><input name="durationDays" type="number" min={steps.at(-1)?.day ?? 1} max={365} required value={duration} onChange={e => setDuration(e.target.value === '' ? '' : Number(e.target.value))} disabled={readOnly} aria-label="Days the sequence spans" className="!w-20 !py-1.5" />{Number(duration) === 1 ? 'day' : 'days'}</label><label className="flex items-center gap-2 text-[12px] text-ink-500">Repeat after<input name="repeatEveryDays" type="number" min={1} max={365} defaultValue={repeatEveryDays ?? ''} disabled={readOnly} aria-label="Repeat after this many days" className="!w-20 !py-1.5" placeholder="never" />days</label><button type="submit" className="btn-primary" disabled={Boolean(validation)}>{submitLabel}</button></div>
      <div aria-hidden className="h-24" /></>}
  </ActionForm>;
}
