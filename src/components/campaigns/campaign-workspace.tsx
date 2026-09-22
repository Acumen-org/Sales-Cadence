'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CampaignDraftSchema, PRIORITY_LABELS, type CampaignDraft } from '@/lib/campaign-planner';
import { prepareStudioAction, previewCalendarAction, saveCalendarAction } from '@/lib/actions/campaign-planner';
import { optionLabel } from '@/lib/twenty/labels';
import { PeoplePicker } from './people-picker';
import { OutreachBuilder } from './outreach-builder';
import { CampaignCalendarView } from './campaign-calendar';
import { Field } from '@/components/ui';
import { IconCheck, IconPlus, IconTrash } from '@/components/icons';
import { readCampaignSelection } from '@/lib/campaign-selection';
import { Modal } from '@/components/modal';
import { calendarDays } from '@/lib/campaign-planner';

type Review = Extract<Awaited<ReturnType<typeof previewCalendarAction>>, { ok: true }>['data'];
export type WorkspacePod = { id: string; name: string; podOwnerValue: string; fos: { id: string; name: string }[] };
export function CampaignWorkspace({ initial, pods, products, campaignId, revision: initialRevision, canPublish = true }: { initial: CampaignDraft; pods: WorkspacePod[]; products: string[]; campaignId?: string; revision?: string; canPublish?: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [id, setId] = useState(campaignId);
  const [revision, setRevision] = useState(initialRevision);
  const [tab, setTab] = useState(0);
  const [activeFlow, setActiveFlow] = useState('default');
  const [subset, setSubset] = useState<string[]>([]);
  const [groupEditor, setGroupEditor] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const [checking, setChecking] = useState(false);
  const [quickDraft, setQuickDraft] = useState<CampaignDraft | null>(null);
  const [quickReview, setQuickReview] = useState<Review | null>(null);
  const [quickError, setQuickError] = useState<string | null>(null);
  const authored = useRef(Boolean(campaignId || initial.flows.length > 1 || initial.flows[0].steps.length > 1));
  const generation = useRef(0);
  const stepLimits = useRef<Record<string, number>>({});
  if (review) stepLimits.current = review.limits;
  const dirty = useRef(false);
  const checkedPeople = useRef('');
  const peopleKey = (d: CampaignDraft) => JSON.stringify([d.name, d.podId, d.startDate, d.endDate, d.productInterest, d.defaultBatchSize, d.fos, d.personIds]);
  useEffect(() => {
    const added = readCampaignSelection(new URLSearchParams(window.location.search).get('selection'));
    if (added.length) { setDraft(d => ({ ...d, personIds: [...new Set([...d.personIds, ...added])] })); dirty.current = true; }
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const change = (next: CampaignDraft) => { generation.current++; dirty.current = true; setDraft(next); setReview(null); setSaved(false); setError(null); };
  const patch = (part: Partial<CampaignDraft>) => change({ ...draft, ...part });
  const flow = draft.flows.find(f => f.id === activeFlow) ?? draft.flows[0];
  const pod = pods.find(p => p.id === draft.podId);
  const basicsValid = draft.name.trim().length > 0 && draft.podId && draft.startDate && draft.endDate >= draft.startDate && draft.productInterest.length > 0 && draft.personIds.length > 0 && Number.isInteger(draft.defaultBatchSize) && draft.defaultBatchSize >= 1 && draft.defaultBatchSize <= 500 && draft.fos.length > 0 && draft.fos.every(f => Number.isInteger(f.batchSize) && f.batchSize >= 1 && f.batchSize <= 500);
  const inspect = async (value: CampaignDraft) => {
    const request = ++generation.current; setChecking(true); setError(null);
    const r = await previewCalendarAction(value, id);
    if (request !== generation.current) return;
    setChecking(false);
    if (r.ok) setReview(r.data); else { setReview(null); setError(r.error); }
  };
  useEffect(() => {
    if (tab !== 1) return;
    const parsed = CampaignDraftSchema.safeParse(draft);
    if (!parsed.success) { setChecking(false); setReview(null); setError(parsed.error.issues.map(i => i.message).join(' ')); return; }
    const timer = setTimeout(() => { void inspect(draft); }, 450);
    const requests = generation;
    return () => { clearTimeout(timer); requests.current++; };
    // inspect intentionally uses the draft captured by this validation request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, tab, id]);
  const nextOutreach = () => {
    if (!basicsValid) { setError('Complete the campaign name, dates, products, team limits and audience first.'); return; }
    start(async () => {
      setError(null);
      const r = await prepareStudioAction(draft, id, !authored.current);
      if (!r.ok) { setError(r.error); return; }
      setReview(r.data);
      if ('starterBlocked' in r.data && r.data.starterBlocked) { setError('These dates, people and FO limits do not yet fit. Adjust them here before continuing.'); return; }
      checkedPeople.current = peopleKey(r.data.draft);
      setDraft(r.data.draft);
      if (!authored.current) dirty.current = true;
      setTab(1);
    });
  };
  const go = (to: number) => {
    if (to < tab) { setTab(to); setError(null); return; }
    if (to === 1 && tab === 0) { nextOutreach(); return; }
    if (to === 2 && tab === 1 && review?.calendar.valid && !checking && checkedPeople.current === peopleKey(draft)) { setTab(2); setError(null); }
  };
  const save = (publish: boolean) => start(async () => {
    setError(null);
    const r = await saveCalendarAction(draft, { id, revision, publish, fingerprint: review?.fingerprint });
    if (!r.ok) { setError(r.error); return; }
    dirty.current = false; setId(r.id); setRevision(r.revision); setSaved(true);
    if (publish) { router.push(`/campaigns/${r.id}`); router.refresh(); }
    else window.history.replaceState(null, '', `/campaigns/${r.id}/edit`);
  });
  const editOutreach = (part: Partial<CampaignDraft>) => { authored.current = true; patch(part); };
  const commitGroup = () => {
    const available = subset.filter(p => draft.personIds.includes(p) && (!draft.assignments[p] || draft.assignments[p] === 'default' || draft.assignments[p] === groupEditor));
    if (!available.length || !groupEditor) return;
    const newId = groupEditor === 'new' ? crypto.randomUUID() : groupEditor;
    const assignments = Object.fromEntries(Object.entries(draft.assignments).filter(([, f]) => f !== newId));
    for (const person of available) assignments[person] = newId;
    editOutreach({ flows: groupEditor === 'new' ? [...draft.flows, { ...structuredClone(draft.flows[0]), id: newId, name: `Custom outreach ${draft.flows.length}` }] : draft.flows, assignments });
    setActiveFlow(newId); setSubset([]); setGroupEditor(null);
  };
  const removeGroup = (flowId: string) => {
    if (!window.confirm('Delete this outreach group and return its people to Default?')) return;
    editOutreach({ flows: draft.flows.filter(f => f.id !== flowId), assignments: Object.fromEntries(Object.entries(draft.assignments).filter(([, f]) => f !== flowId)) });
    setActiveFlow('default');
  };
  const applySuggestion = (next: CampaignDraft) => { authored.current = true; checkedPeople.current = peopleKey(next); change(next); if (tab === 0) setTab(1); };
  const updateCalendar = (next: CampaignDraft) => start(async () => {
    setQuickError(null); setQuickReview(null);
    const r = await prepareStudioAction(next, id);
    if (!r.ok) { setQuickError(r.error); return; }
    if (!r.data.calendar.valid) { setQuickReview(r.data); return; }
    change(next); checkedPeople.current = peopleKey(next); setReview(r.data); setQuickDraft(null);
  });
  const steps = ['People', 'Outreach', 'Schedule'];
  return <div className="space-y-5">
    <header className="surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><span className="text-xs font-semibold uppercase tracking-widest text-brand-700">Campaign studio</span><h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-900">{draft.name || 'Build your next conversation'}</h1></div><div className="flex items-center gap-2">{saved && <span role="status" className="text-sm font-semibold text-green-700">Draft saved</span>}<button type="button" className="btn-secondary" disabled={pending} onClick={() => save(false)}>Save draft</button></div></div>
      <nav aria-label="Campaign setup" className="mt-6 grid grid-cols-3 gap-1 sm:flex sm:gap-2">{steps.map((name, i) => <button type="button" key={name} disabled={pending || (i > tab && (i === 1 ? !basicsValid : tab !== 1 || !review?.calendar.valid || checking))} aria-current={tab === i ? 'step' : undefined} onClick={() => go(i)} className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-xs font-semibold sm:gap-2 sm:px-4 sm:text-sm ${tab === i ? 'bg-ink-900 text-white shadow-sm' : 'bg-white/70 text-ink-600 hover:bg-white'}`}><span className="opacity-60">0{i + 1}</span>{name}</button>)}</nav>
    </header>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3"><strong className="block text-red-900">Check these details</strong><p className="mt-2 text-sm text-red-800">{error}</p></div>}
    <fieldset disabled={pending} className="min-w-0 space-y-5">
    {tab === 0 && <>
      <section className="surface grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-4">
        <Field label="Campaign name" required><input aria-label="Campaign name" value={draft.name} onChange={e => patch({ name: e.target.value })} className="w-full" /></Field>
        <Field label="Pod" required><select aria-label="Campaign pod" value={draft.podId} onChange={e => { const p = pods.find(p => p.id === e.target.value)!; patch({ podId: p.id, fos: [], personIds: [], assignments: {} }); }} className="w-full">{pods.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Start date" required><input aria-label="Start date" type="date" value={draft.startDate} onChange={e => patch({ startDate: e.target.value })} className="w-full" /></Field>
        <Field label="End date" required><input aria-label="End date" type="date" value={draft.endDate} min={draft.startDate} onChange={e => patch({ endDate: e.target.value })} className="w-full" /></Field>
        <div className="md:col-span-2 lg:col-span-4"><span className="mb-2 block text-sm font-medium">Products</span><div className="flex flex-wrap gap-2">{products.map(p => <button key={p} type="button" aria-pressed={draft.productInterest.includes(p)} onClick={() => patch({ productInterest: draft.productInterest.includes(p) ? draft.productInterest.filter(x => x !== p) : [...draft.productInterest, p] })} className={draft.productInterest.includes(p) ? 'chip' : 'chip-muted !border !border-line'}>{optionLabel(p)}</button>)}</div></div>
      </section>
      <section className="surface p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Who will run this campaign?</h2><label className="flex items-center gap-3 text-sm">New people/day<input aria-label="Default new people per day" className="!w-20 !font-bold" type="number" min={1} max={500} value={draft.defaultBatchSize || ''} onChange={e => { const n = Number(e.target.value); patch({ defaultBatchSize: n, fos: draft.fos.map(f => f.batchSize === draft.defaultBatchSize ? { ...f, batchSize: n } : f) }); }} /></label></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{pod?.fos.map(fo => { const selected = draft.fos.find(f => f.id === fo.id); return <div key={fo.id} className={`flex items-center justify-between gap-2 rounded-xl border p-3 ${selected ? 'border-brand-200 bg-brand-50/40' : 'border-line'}`}><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={!!selected} onChange={() => patch({ fos: selected ? draft.fos.filter(f => f.id !== fo.id) : [...draft.fos, { id: fo.id, batchSize: draft.defaultBatchSize }] })} />{fo.name}</label>{selected && <input type="number" aria-label={`${fo.name} new people per day`} min={1} max={500} value={selected.batchSize || ''} className="!w-20 !font-bold" onChange={e => patch({ fos: draft.fos.map(f => f.id === fo.id ? { ...f, batchSize: Number(e.target.value) } : f) })} />}</div>; })}</div></section>
      <section className="surface p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Your audience <span className="ml-2 rounded-full bg-brand-50 px-2 py-1 text-brand-800">{draft.personIds.length}</span></h2><span className="text-xs text-ink-600">Priority: {PRIORITY_LABELS.slice(0, 5).join(' → ')}</span></div><PeoplePicker key={draft.podId} initialPod={pod?.podOwnerValue} value={draft.personIds} onChange={personIds => { setSubset(s => s.filter(id => personIds.includes(id))); patch({ personIds, assignments: Object.fromEntries(Object.entries(draft.assignments).filter(([id]) => personIds.includes(id))) }); }} /></section>
    </>}
    {tab === 0 && review && !review.calendar.valid && <PlannerFeedback review={review} onApply={applySuggestion} />}
    {tab === 1 && <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="surface space-y-2 p-3 lg:sticky lg:top-4" aria-label="Outreach groups">
        <h2 className="px-2 py-2 font-semibold">Outreach groups</h2>
        {draft.flows.map(f => <div key={f.id} className={`rounded-lg border p-3 ${flow.id === f.id ? 'border-brand-300 bg-brand-50/40' : 'border-line'}`}>
          <div className="flex items-center gap-2"><button type="button" onClick={() => setActiveFlow(f.id)} className="min-w-0 flex-1 truncate text-left text-sm font-semibold">{f.name || 'Untitled outreach'}</button>{f.id !== 'default' && <button type="button" className="btn-icon-ghost text-ink-500 hover:text-red-700" aria-label={`Delete ${f.name || 'untitled outreach'}`} onClick={() => removeGroup(f.id)}><IconTrash size={14} /></button>}</div>
          {flow.id === f.id && f.id !== 'default' && <input aria-label="Outreach group name" className="mt-2 w-full !text-sm" placeholder="Name this outreach" value={f.name} onChange={e => editOutreach({ flows: draft.flows.map(x => x.id === f.id ? { ...x, name: e.target.value } : x) })} />}
          <div className="mt-2 flex items-center justify-between text-xs"><span><strong>{draft.personIds.filter(id => (draft.assignments[id] ?? 'default') === f.id).length}</strong> people</span><span><strong>{f.steps.length}</strong> steps</span></div>
          {f.id !== 'default' && <button type="button" className="mt-2 text-xs font-medium text-brand-700 hover:underline" onClick={() => { setSubset(draft.personIds.filter(id => draft.assignments[id] === f.id)); setGroupEditor(f.id); }}>Manage people</button>}
        </div>)}
        <button type="button" className="btn-secondary w-full" disabled={draft.flows.length >= 30 || draft.personIds.every(id => draft.assignments[id] && draft.assignments[id] !== 'default')} onClick={() => { setSubset([]); setGroupEditor('new'); }}><IconPlus size={14} /> Add outreach group</button>
      </aside>
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{flow.name || 'Untitled outreach'}</h2><span role="status" className="text-xs font-medium text-ink-600">{checking ? 'Checking fit…' : review?.calendar.valid ? 'Fits your campaign' : 'Review spacing below'}</span></div>
        {review && !review.calendar.valid && <PlannerFeedback review={review} onApply={applySuggestion} />}
        <section className="surface p-4"><OutreachBuilder key={flow.id} steps={flow.steps} maxSteps={Math.min(stepLimits.current[flow.id] ?? 60, calendarDays(draft.startDate, draft.endDate).length)} onChange={steps => editOutreach({ flows: draft.flows.map(f => f.id === flow.id ? { ...f, steps } : f) })} /></section>
      </div>
    </div>}
    {tab === 2 && review?.calendar.valid && <section className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4"><div className="flex items-center gap-2 text-sm font-medium"><IconCheck size={16} className="text-brand-700" /> Every working day covered <span className="text-ink-400">·</span><strong>{draft.personIds.length}</strong> people</div><div className="flex gap-2"><button type="button" className="btn-secondary btn-sm" onClick={() => { setQuickDraft(structuredClone(draft)); setQuickReview(null); setQuickError(null); }}>Dates & limits</button><button type="button" className="btn-secondary btn-sm" onClick={() => setTab(1)}>Edit outreach</button></div></div>
      <div className="p-4 sm:p-5"><CampaignCalendarView draft={draft} calendar={review.calendar} /></div>
    </section>}
    </fieldset>
    {groupEditor && <Modal label={groupEditor === 'new' ? 'Add outreach group' : 'Manage group people'} onClose={() => setGroupEditor(null)}><div className="space-y-4 p-5"><h2 className="text-lg font-semibold">{groupEditor === 'new' ? 'Add outreach group' : 'Manage group people'}</h2><p className="text-sm text-ink-600">Choose people from Default. People in another custom group are unavailable.</p><PeoplePicker withinIds={draft.personIds} disabledIds={draft.personIds.filter(id => draft.assignments[id] && draft.assignments[id] !== 'default' && draft.assignments[id] !== groupEditor)} value={subset} onChange={setSubset} /><div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setGroupEditor(null)}>Cancel</button><button type="button" className="btn-primary" disabled={!subset.length} onClick={commitGroup}>{groupEditor === 'new' ? 'Create outreach group' : 'Save people'} ({subset.length})</button></div></div></Modal>}
    {quickDraft && <Modal label="Dates and limits" onClose={() => setQuickDraft(null)}><div className="space-y-4 p-5"><h2 className="text-lg font-semibold">Dates and limits</h2><div className="grid grid-cols-2 gap-3"><Field label="Start date"><input aria-label="Adjust start date" type="date" value={quickDraft.startDate} onChange={e => { setQuickDraft({ ...quickDraft, startDate: e.target.value }); setQuickReview(null); }} /></Field><Field label="End date"><input aria-label="Adjust end date" type="date" value={quickDraft.endDate} onChange={e => { setQuickDraft({ ...quickDraft, endDate: e.target.value }); setQuickReview(null); }} /></Field></div>{quickDraft.fos.map(f => <label key={f.id} className="flex items-center justify-between gap-3 text-sm">{pod?.fos.find(fo => fo.id === f.id)?.name}<input aria-label={`Adjust ${pod?.fos.find(fo => fo.id === f.id)?.name ?? 'FO'} new people per day`} className="!w-20 !font-bold" type="number" min={1} max={500} value={f.batchSize || ''} onChange={e => { setQuickDraft({ ...quickDraft, fos: quickDraft.fos.map(fo => fo.id === f.id ? { ...fo, batchSize: Number(e.target.value) } : fo) }); setQuickReview(null); }} /></label>)}{quickError && <p role="alert" className="text-sm text-red-700">{quickError}</p>}{quickReview && <PlannerFeedback review={quickReview} onApply={updateCalendar} />}<div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setQuickDraft(null)}>Cancel</button><button type="button" className="btn-primary" disabled={pending} onClick={() => updateCalendar(quickDraft)}>Update calendar</button></div></div></Modal>}
    <footer className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white/95 p-4 shadow-sm backdrop-blur"><span className="text-sm text-ink-600"><strong className="text-ink-900">{draft.personIds.length}</strong> people · <strong className="text-ink-900">{draft.fos.length}</strong> FOs</span><div className="flex gap-2">{tab > 0 && <button type="button" disabled={pending} className="btn-ghost" onClick={() => go(tab - 1)}>Back</button>}{tab === 0 ? <button type="button" className="btn-primary" disabled={pending || !basicsValid} onClick={nextOutreach}>{pending ? 'Preparing outreach…' : 'Next: Outreach'}</button> : tab === 1 ? <button type="button" disabled={pending || checking || !review?.calendar.valid} className="btn-primary" onClick={() => go(2)}>Next: Schedule</button> : <button type="button" disabled={pending || !review?.calendar.valid} className="btn-primary" onClick={() => save(canPublish)}>{canPublish ? 'Publish campaign' : 'Save for leader review'}</button>}</div></footer>
  </div>;
}

function PlannerFeedback({ review, onApply }: { review: Review; onApply: (draft: CampaignDraft) => void }) {
  return <div className="rounded-lg border border-line bg-white text-sm" aria-live="polite"><div className="border-b border-line px-4 py-3 font-semibold">Adjust this plan</div><div className="divide-y divide-line">{review.calendar.issues.map((issue, i) => <div key={i} className="px-4 py-3"><p className="font-medium text-ink-900">{issue.title}</p><p className="mt-1 text-xs leading-5 text-ink-600">{issue.detail}</p></div>)}</div>{review.suggestions.length > 0 && <div className="border-t border-line">{review.suggestions.map((s, i) => <div key={i} className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-0"><div><p className="font-medium">{s.label}</p><p className="mt-1 text-xs text-ink-600">{s.detail}</p></div><button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => onApply(s.draft)}>Apply</button></div>)}</div>}</div>;
}
