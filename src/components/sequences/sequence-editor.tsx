'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACTION_LABELS, ACTION_TYPES, newStepId, StepsSchema, type ActionType, type SequenceStep, type StepAction } from '@/lib/sequences/steps';
import { ActionForm } from '@/components/action-form';
import type { ActionResult } from '@/lib/actions/users';
import { ActionIcon, IconArrowDown, IconArrowUp, IconLock, IconPlus, IconTrash } from '@/components/icons';
import { Field } from '@/components/ui';
import { RichTextEditor } from '@/components/rich-text-editor';

function blankAction(type: ActionType): StepAction { return { id: newStepId('act'), type, label: ACTION_LABELS[type], template: '', bodyHtml: '<p></p>' }; }
function htmlOf(a: StepAction) { return a.bodyHtml ?? '<p>' + (a.template ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>'; }

export function SequenceEditor({ sequenceId, initialSteps, action, submitLabel, header, lockedSteps = {}, readOnly = false }: {
  sequenceId?: string; initialSteps: SequenceStep[]; action: (data: FormData) => Promise<ActionResult>; submitLabel: string;
  header?: React.ReactNode; lockedSteps?: Record<string, number>; readOnly?: boolean;
}) {
  const router = useRouter();
  const [steps, setSteps] = useState(initialSteps);
  const [dragged, setDragged] = useState<number | null>(null);
  const validation = useMemo(() => { const parsed = StepsSchema.safeParse(steps); return parsed.success ? null : parsed.error.issues.map(i => i.message).join(' · '); }, [steps]);
  const locked = (i: number) => readOnly || Boolean(lockedSteps[steps[i]?.id]);
  const update = (i: number, patch: Partial<SequenceStep>) => { if (!locked(i)) setSteps(s => s.map((step, n) => n === i ? { ...step, ...patch } : step)); };
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
    <ol className="space-y-0">
      {steps.map((step, i) => <li key={step.id} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragged !== null) move(dragged, i); setDragged(null); }}>
        {i > 0 && <div className="ml-8 flex h-11 items-center border-l-2 border-brand-200 pl-5 text-xs text-ink-500">Wait <span className="mx-1 font-medium text-ink-900">{step.day - steps[i - 1].day}</span> business {step.day - steps[i - 1].day === 1 ? 'day' : 'days'}</div>}
        <section className="surface overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-canvas/50 px-5 py-4">
            {!readOnly && <button draggable={!locked(i)} type="button" aria-label={'Drag step ' + (i + 1)} disabled={locked(i)} onDragStart={() => setDragged(i)} onDragEnd={() => setDragged(null)} className="cursor-grab px-1 text-lg text-ink-500 disabled:cursor-default">⠿</button>}
            <span className="rounded-lg bg-brand-900 px-3 py-2 text-sm font-bold text-white">{i + 1}</span>
            <label className="flex items-center gap-2 text-xs text-ink-500">Business day <input aria-label={'Step ' + (i + 1) + ' business day'} type="number" min={i ? steps[i - 1].day + 1 : 1} max={steps[i + 1] ? steps[i + 1].day - 1 : 999} value={step.day} onChange={e => update(i, { day: Number(e.target.value) })} disabled={locked(i)} className="!w-20 !font-bold !text-ink-900" /></label>
            <div className="ml-auto flex items-center gap-1">
              {lockedSteps[step.id] ? <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[12px] font-semibold text-amber-800" title="Work or cancel these before changing this step"><IconLock size={12} />Locked · <strong>{lockedSteps[step.id]}</strong> open {lockedSteps[step.id] === 1 ? 'action' : 'actions'}</span> : null}
              {!readOnly && <><button type="button" className="btn-ghost btn-sm" disabled={locked(i) || !i || locked(i - 1)} aria-label={'Move step ' + (i + 1) + ' up'} onClick={() => move(i, i - 1)}><IconArrowUp size={14} /></button><button type="button" className="btn-ghost btn-sm" disabled={locked(i) || i === steps.length - 1 || locked(i + 1)} aria-label={'Move step ' + (i + 1) + ' down'} onClick={() => move(i, i + 1)}><IconArrowDown size={14} /></button><button type="button" className="btn-ghost btn-sm" disabled={locked(i) || steps.length < 2 || steps.slice(i + 1).some(s => lockedSteps[s.id])} aria-label={'Remove step ' + (i + 1)} onClick={() => setSteps(s => s.filter(x => x.id !== step.id))}><IconTrash size={14} /></button></>}
            </div>
          </div>
          <div className="space-y-4 p-5">
            {step.actions.map((a, j) => <fieldset key={a.id} disabled={locked(i)} className="space-y-3 rounded-xl border border-line bg-canvas/30 p-4">
              <div className="flex items-center gap-2"><span className="rounded-lg bg-white p-2 text-brand-700"><ActionIcon action={a.type} size={19} /></span><strong className="text-sm">{ACTION_LABELS[a.type]}</strong>{!readOnly && step.actions.length > 1 && <button type="button" aria-label={'Remove ' + ACTION_LABELS[a.type] + ' module'} className="btn-ghost btn-sm ml-auto" onClick={() => update(i, { actions: step.actions.filter(x => x.id !== a.id) })}><IconTrash size={14} /></button>}</div>
              {a.type === 'EMAIL' && <Field label="Subject"><input aria-label={'Step ' + (i + 1) + ' email subject'} className="w-full !font-semibold" value={a.subject ?? ''} onChange={e => changeAction(i, j, { subject: e.target.value })} /></Field>}
              <RichTextEditor value={htmlOf(a)} label={'Step ' + (i + 1) + ' ' + ACTION_LABELS[a.type]} disabled={locked(i)} onChange={(bodyHtml, template) => changeAction(i, j, { bodyHtml, template })} />
            </fieldset>)}
            {!locked(i) && <div className="flex flex-wrap items-center gap-2"><span className="mr-1 text-xs text-ink-500">Add to this step</span>{ACTION_TYPES.map(type => <button key={type} type="button" className="btn-secondary btn-sm" onClick={() => update(i, { actions: [...step.actions, blankAction(type)] })}><ActionIcon action={type} size={13} />{ACTION_LABELS[type]}</button>)}</div>}
          </div>
        </section>
      </li>)}
    </ol>
    {!readOnly && <><div className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed border-brand-300 bg-brand-50/40 p-5"><span className="mr-2 text-sm font-semibold">New touchpoint</span>{ACTION_TYPES.map(type => <button key={type} type="button" className="btn-secondary" onClick={() => append(type)}><IconPlus size={13} /><ActionIcon action={type} size={14} />{ACTION_LABELS[type]}</button>)}</div>
      {/* The bar floats over the page, so the page reserves its height rather than hiding a card behind it. */}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-4 rounded-xl border border-line bg-white p-3 shadow-lg">{validation && <p role="alert" className="mr-auto text-sm font-semibold text-red-700">{validation}</p>}<span className="text-[12px] text-ink-500"><span className="font-medium text-ink-900">{steps.length}</span> {steps.length === 1 ? 'touchpoint' : 'touchpoints'} over <span className="font-medium text-ink-900">{(steps.at(-1)?.day ?? 1)}</span> business {(steps.at(-1)?.day ?? 1) === 1 ? 'day' : 'days'}</span><button type="submit" className="btn-primary" disabled={Boolean(validation)}>{submitLabel}</button></div>
      <div aria-hidden className="h-24" /></>}
  </ActionForm>;
}
