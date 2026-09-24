'use client';
import { useState } from 'react';
import { ACTION_LABELS, ACTION_TYPES, type ActionType, type SequenceStep, newStepId } from '@/lib/sequences/steps';
import { RichTextEditor } from '@/components/rich-text-editor';
import { ActionIcon, IconArrowDown, IconArrowUp, IconClock, IconPlus, IconTrash } from '@/components/icons';

const html = (text: string) => '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>';
export function OutreachBuilder({ steps, onChange, maxSteps = 60 }: { maxSteps?: number; steps: SequenceStep[]; onChange: (steps: SequenceStep[]) => void }) {
  const [open, setOpen] = useState<string | null>(steps[0]?.id ?? null);
  const [drag, setDrag] = useState<number | null>(null);
  const update = (index: number, patch: Partial<SequenceStep>) => onChange(steps.map((s, i) => i === index ? { ...s, ...patch } : s));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    const days = steps.map(s => s.day), next = [...steps]; next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next.map((s, i) => ({ ...s, day: days[i] })));
  };
  const append = (type: ActionType) => {
    const step = { id: newStepId(), day: (steps.at(-1)?.day ?? -1) + 2, actions: [{ id: newStepId('act'), type, label: ACTION_LABELS[type], template: '' }] };
    onChange([...steps, step]); setOpen(step.id);
  };
  return <div className="space-y-4">
    {steps.map((step, i) => <div key={step.id} data-outreach-step={i} className={drag === i ? 'opacity-60' : ''}>
      {i > 0 && <div className="flex items-center gap-3 py-3 pl-6 text-sm text-ink-600"><IconClock size={15} className="text-ink-400" /><span>Wait</span><input aria-label={`Gap before step ${i + 1}`} type="number" min={1} max={366} className="!w-20 text-center !font-bold" value={step.day - steps[i - 1].day} onChange={e => {
        const gap = Number(e.target.value); if (!Number.isInteger(gap) || gap < 1 || gap > 366) return;
        const delta = gap - (step.day - steps[i - 1].day); onChange(steps.map((s, n) => ({ ...s, day: s.day + (n >= i ? delta : 0) })));
      }} /><span>{step.day - steps[i - 1].day === 1 ? 'calendar day' : 'calendar days'}</span></div>}
      <section className={`overflow-hidden rounded-2xl border bg-white ${open === step.id ? 'border-brand-300 shadow-sm' : 'border-line'}`}>
        <div className="flex items-center gap-3 p-4">
          <button type="button" onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDrag(i); }} onPointerUp={e => {
            const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-outreach-step]');
            const to = target?.getAttribute('data-outreach-step');
            if (to !== null && to !== undefined) move(i, Number(to));
            e.currentTarget.releasePointerCapture(e.pointerId); setDrag(null);
          }} onPointerCancel={() => setDrag(null)} aria-label={`Drag step ${i + 1}`} className="touch-none cursor-grab rounded-lg bg-brand-50 px-3 py-2 font-bold text-brand-800">{i + 1}</button>
          <button type="button" aria-expanded={open === step.id} onClick={() => setOpen(open === step.id ? null : step.id)} className="min-w-0 flex-1 text-left"><span className="block font-semibold text-ink-900">{step.title || `Step ${i + 1}`}</span><span className="mt-1 flex flex-wrap gap-3 text-sm text-ink-600">{step.actions.map(a => <span key={a.id} className="flex items-center gap-1.5"><ActionIcon action={a.type} size={14} />{ACTION_LABELS[a.type]}</span>)}</span></button>
          <button type="button" className="btn-ghost btn-sm" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><IconArrowUp size={15} /></button>
          <button type="button" className="btn-ghost btn-sm" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, i + 1)}><IconArrowDown size={15} /></button>
          <button type="button" className="btn-ghost btn-sm text-red-700" aria-label={`Remove step ${i + 1}`} disabled={steps.length === 1} onClick={() => { const next = steps.filter((_, n) => n !== i); const offset = next[0].day - 1; onChange(next.map(s => ({ ...s, day: s.day - offset }))); }}><IconTrash size={15} /></button>
        </div>
        {open === step.id && <div className="space-y-4 border-t border-line bg-canvas/40 p-4">
          <label className="block text-sm font-medium">Step name<input className="mt-1 w-full" aria-label={`Step ${i + 1} name`} value={step.title ?? ''} onChange={e => update(i, { title: e.target.value })} /></label>
          {step.actions.map((a, j) => <div key={a.id} className="space-y-3 rounded-xl border border-line bg-white p-3">
            <div className="flex items-center justify-between"><span className="flex items-center gap-2 font-semibold"><ActionIcon action={a.type} />{ACTION_LABELS[a.type]}</span>{step.actions.length > 1 && <button type="button" className="btn-ghost btn-sm" aria-label={`Remove ${ACTION_LABELS[a.type]} from step ${i + 1}`} onClick={() => update(i, { actions: step.actions.filter((_, n) => n !== j) })}>Remove</button>}</div>
            {a.type === 'EMAIL' && <input aria-label={`Step ${i + 1} email subject`} placeholder="Email subject" value={a.subject ?? ''} onChange={e => update(i, { actions: step.actions.map((act, n) => n === j ? { ...act, subject: e.target.value } : act) })} className="w-full" />}
            <RichTextEditor label={`Step ${i + 1} ${ACTION_LABELS[a.type]} message`} value={a.bodyHtml ?? html(a.template ?? '')} onChange={(bodyHtml, template) => update(i, { actions: step.actions.map((act, n) => n === j ? { ...act, bodyHtml, template } : act) })} />
          </div>)}
          {step.actions.length < 4 && <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-ink-600">Add to this step</span>{ACTION_TYPES.filter(t => !step.actions.some(a => a.type === t)).map(type => <button type="button" key={type} className="btn-secondary btn-sm" onClick={() => update(i, { actions: [...step.actions, { id: newStepId('act'), type, label: ACTION_LABELS[type], template: '' }] })}><ActionIcon action={type} size={14} />{ACTION_LABELS[type]}</button>)}</div>}
        </div>}
      </section>
    </div>)}
    <div className="flex flex-wrap gap-2 rounded-2xl border border-dashed border-brand-300 p-4">{ACTION_TYPES.map(type => <button key={type} type="button" className="btn-secondary btn-sm" disabled={steps.length >= maxSteps} title={steps.length >= maxSteps ? 'No room for another step with the current dates, audience and limits' : undefined} onClick={() => append(type)}><IconPlus size={14} />{ACTION_LABELS[type]}</button>)}</div>
  </div>;
}
