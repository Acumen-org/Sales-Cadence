'use client';
import { useState } from 'react';
import { calendarDateLabel, weekday, PRIORITY_LABELS, contactPriority, type CampaignDraft, type CampaignCalendar } from '@/lib/campaign-planner';
import { ActionIcon } from '@/components/icons';
import { Modal } from '@/components/modal';

export function CampaignCalendarView({ draft, calendar }: { draft: CampaignDraft; calendar: CampaignCalendar }) {
  const [foId, setFoId] = useState(calendar.fos[0]?.id ?? 'all');
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ batchId: string; step: number } | null>(null);
  const picked = calendar.batches.find(b => b.id === selected?.batchId);
  const flow = draft.flows.find(f => f.id === picked?.flowId);
  const selectedFo = calendar.fos.find(f => f.id === foId);
  const visible = calendar.batches.filter(b => foId === 'all' || b.foId === foId);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Your outreach calendar</h2><p className="text-sm text-ink-600"><span className="font-medium tabular-nums text-ink-900">{calendar.days.length}</span> working days</p></div><select aria-label="Calendar FO" value={foId} onChange={e => { setFoId(e.target.value); setFocus(null); }} className="!w-auto"><option value="all">All FOs</option>{calendar.fos.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
    {selectedFo && focus && <div className="flex"><button className="btn-ghost btn-sm" type="button" onClick={() => setFocus(null)}>Show all batches</button></div>}
    <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 xl:grid-cols-5">
      {Array.from({ length: calendar.days.length ? weekday(calendar.days[0]) - 1 : 0 }, (_, i) => <div key={`lead-${i}`} aria-hidden className="hidden bg-canvas xl:block" />)}
      {calendar.days.map(day => {
        const events = visible.flatMap(b => { const step = b.dates.indexOf(day); return step < 0 ? [] : [{ b, step }]; });
        return <section key={day} className={`min-h-36 p-3 ${['', 'xl:col-start-1', 'xl:col-start-2', 'xl:col-start-3', 'xl:col-start-4', 'xl:col-start-5'][weekday(day)]} ${events.length ? 'bg-white' : 'bg-canvas'}`} aria-label={calendarDateLabel(day)}>
          <div className="mb-3 flex items-start justify-between gap-1"><time dateTime={day} className="text-xs font-semibold text-ink-600">{calendarDateLabel(day).replace(/, 20\d\d$/, '')}</time><span className="text-sm tabular-nums text-ink-900">{events.reduce((n, e) => n + e.b.personIds.length, 0)} <span className="text-xs text-ink-500">people</span></span></div>
          {foId === 'all' ? calendar.fos.map(fo => <button type="button" key={fo.id} onClick={() => setFoId(fo.id)} className="mb-1 flex w-full justify-between rounded-lg bg-canvas p-2 text-xs"><span>{fo.name}</span><strong>{events.filter(e => e.b.foId === fo.id).reduce((n, e) => n + e.b.personIds.length, 0)}</strong></button>) : events.map(({ b, step }) => {
            const f = draft.flows.find(f => f.id === b.flowId)!;
            return <button type="button" key={b.id} onClick={() => { setFocus(b.id); setSelected({ batchId: b.id, step }); }} className={`mb-2 w-full rounded-md border-l-2 p-2.5 text-left transition ${step === 0 ? 'border-brand-500 bg-[#f1f6f4]' : 'border-ink-300 bg-[#f8faf9]'} ${focus && focus !== b.id ? 'opacity-40' : ''}`}>
              <span className="block truncate text-xs font-semibold">{f.name} · Batch {b.id.split(':').at(-1)}</span><span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">Step {step + 1}{f.steps[step].actions.map(a => <ActionIcon key={a.id} action={a.type} size={13} />)}</span><span className="mt-2 block text-xs"><strong>{b.personIds.length}</strong> people · {PRIORITY_LABELS[b.priority]}</span>
            </button>;
          })}
          {!events.length && <span className="text-xs font-medium text-amber-800">No coverage</span>}
        </section>;
      })}
      {Array.from({ length: calendar.days.length ? 5 - weekday(calendar.days.at(-1)!) : 0 }, (_, i) => <div key={`trail-${i}`} aria-hidden className="hidden bg-canvas xl:block" />)}
    </div>
    {selected && picked && flow && <Modal label={`${flow.name} · Step ${selected.step + 1}`} onClose={() => setSelected(null)}>
      <div className="space-y-4 p-5"><p className="font-semibold">{calendarDateLabel(picked.dates[selected.step])}</p><div className="flex flex-wrap gap-2">{picked.dates.map((d, i) => <button type="button" className={i === selected.step ? 'chip' : 'chip-muted'} key={d} onClick={() => setSelected({ batchId: picked.id, step: i })}>Step {i + 1} · {d}</button>)}</div><div className="max-h-64 overflow-y-auto divide-y divide-line">{picked.personIds.map(id => { const p = calendar.people.find(p => p.id === id); return <div key={id} className="flex justify-between gap-2 py-2 text-sm"><span>{p?.name ?? id}</span><span className="chip-muted">{p ? PRIORITY_LABELS[contactPriority(p)] : ''}</span></div>; })}</div>{flow.steps[selected.step].actions.map(a => <div key={a.id} className="rounded-xl border border-line p-3"><strong>{a.label}</strong>{a.subject && <p className="mt-1 font-medium">{a.subject}</p>}<p className="mt-2 whitespace-pre-wrap text-sm">{a.template}</p></div>)}</div>
    </Modal>}
  </div>;
}
