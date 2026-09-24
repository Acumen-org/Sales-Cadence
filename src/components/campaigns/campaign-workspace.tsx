'use client';
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CampaignDraftSaveSchema, CampaignDraftSchema, calendarDays, outreachIsAutomatic, shortDateLabel, workingDay, type CalendarSuggestion, type CampaignDraft } from '@/lib/campaign-planner';
import { addDays } from '@/lib/dates';
import type { LeftOut } from '@/lib/campaign-planning-service';
import { prepareStudioAction, previewCalendarAction, saveCalendarAction } from '@/lib/actions/campaign-planner';
import { optionLabel } from '@/lib/twenty/labels';
import { PeoplePicker } from './people-picker';
import { OutreachBuilder } from './outreach-builder';
import { CampaignCalendarView } from './campaign-calendar';
import { Field } from '@/components/ui';
import { IconAlert, IconBolt, IconCheck, IconChevronRight, IconPlus, IconTrash } from '@/components/icons';
import { readCampaignSelection } from '@/lib/campaign-selection';
import { Modal } from '@/components/modal';

type Review = Extract<Awaited<ReturnType<typeof previewCalendarAction>>, { ok: true }>['data'];
export type WorkspacePod = { id: string; name: string; podOwnerValue: string; fos: { id: string; name: string }[] };
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * The campaign studio. `draft` is what the campaign owner asked for - their audience, their
 * paces, their outreach. `review` is the plan the server fitted from it: the people who can be
 * reached, the paces that cover every working day, and who was left out and why. Publishing
 * sends the request again and the server refits it; the fingerprint proves it is the plan shown.
 */
export function CampaignWorkspace({ initial, pods, products, campaignId, revision: initialRevision, canPublish = true, status, today }: { initial: CampaignDraft; pods: WorkspacePod[]; products: string[]; campaignId?: string; revision?: string; canPublish?: boolean; status?: string; today: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [id, setId] = useState(campaignId);
  const [tab, setTab] = useState(0);
  const [activeFlow, setActiveFlow] = useState('default');
  const [subset, setSubset] = useState<string[]>([]);
  const [groupEditor, setGroupEditor] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [pending, start] = useTransition();
  const [planning, setPlanning] = useState(false);
  const [hold, setHold] = useState<string | null>(null);
  // The draft before the last applied fix, so it can be taken back.
  const [undo, setUndo] = useState<{ label: string; draft: CampaignDraft } | null>(null);
  const [checking, setChecking] = useState(false);
  const [quickDraft, setQuickDraft] = useState<CampaignDraft | null>(null);
  const [quickReview, setQuickReview] = useState<Review | null>(null);
  const [quickError, setQuickError] = useState<string | null>(null);
  const generation = useRef(0);
  const stepLimits = useRef<Record<string, number>>({});
  if (review) stepLimits.current = review.limits;
  const dirty = useRef(false);
  const edits = useRef(0);
  const checkedPeople = useRef('');
  const feedback = useRef<HTMLDivElement>(null);
  // Saves run one at a time against the latest revision; refs let a queued save see the newest.
  const latest = useRef(draft); latest.current = draft;
  const idRef = useRef(campaignId); const revRef = useRef(initialRevision);
  const inFlight = useRef<Promise<boolean>>(Promise.resolve(true));
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The error a failed save showed, so the banner can say Not saved only for that one.
  const lastSaveError = useRef<string | null>(null);
  // The draft the plan on screen was made from; step 02 does not ask again for the same draft.
  const reviewedKey = useRef('');
  const canAutosave = !status || status === 'DRAFT' || status === 'PENDING_APPROVAL';
  const peopleKey = (d: CampaignDraft) => JSON.stringify([d.name, d.podId, d.startDate, d.endDate, d.productInterest, d.defaultBatchSize, d.fos, d.personIds]);
  const reshapes = (d: CampaignDraft) => outreachIsAutomatic(d, campaignId);

  useEffect(() => {
    const added = readCampaignSelection(new URLSearchParams(window.location.search).get('selection'));
    if (added.length) { setDraft(d => ({ ...d, personIds: [...new Set([...d.personIds, ...added])] })); dirty.current = true; edits.current++; }
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const persist = (options: { auto?: boolean; publish?: boolean; fingerprint?: string } = {}) => {
    const run = async () => {
      const snapshot = latest.current, at = edits.current;
      if (!options.publish) setSaveState('saving');
      const r = await saveCalendarAction(snapshot, { id: idRef.current, revision: revRef.current, ...options });
      if (!r.ok) { setSaveState('failed'); lastSaveError.current = r.error; setError(r.error); return false; }
      idRef.current = r.id; revRef.current = r.revision; setId(r.id);
      if (at === edits.current) { dirty.current = false; setSaveState('saved'); } else setSaveState('idle');
      // The native call, not Next's patched one: a reload then opens this draft, while the studio
      // stays mounted. Next treats its own replaceState to another route as a navigation and
      // remounts the page, which throws away whatever is open (measured on the production build).
      if (!options.publish && window.location.pathname !== `/campaigns/${r.id}/edit`) History.prototype.replaceState.call(window.history, window.history.state, '', `/campaigns/${r.id}/edit`);
      return true;
    };
    const next = inFlight.current.then(run, run);
    inFlight.current = next;
    return next;
  };
  useEffect(() => {
    if (!canAutosave || !dirty.current || !CampaignDraftSaveSchema.safeParse(draft).success) return;
    autosaveTimer.current = setTimeout(() => { void persist({ auto: true }); }, 1500);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [draft, canAutosave]);

  const change = (next: CampaignDraft) => { setHold(null); setUndo(null); generation.current++; edits.current++; dirty.current = true; setDraft(next); setReview(null); setSaveState(s => s === 'saving' ? s : 'idle'); setError(null); };
  const patch = (part: Partial<CampaignDraft>) => change({ ...draft, ...part });
  const flow = draft.flows.find(f => f.id === activeFlow) ?? draft.flows[0];
  const pod = pods.find(p => p.id === draft.podId);
  // While step 02 re-checks after an edit, the last plan stays on screen with its buttons waiting,
  // so the panel and the plan strip do not vanish and reappear under the cursor on every keystroke.
  const lastReview = useRef<Review | null>(null);
  if (review) lastReview.current = review;
  const view = review ?? (tab === 1 ? lastReview.current : null);
  const stale = !review;
  const planned = view?.calendar.valid ? view.draft : null;
  const plannedIds = planned?.personIds ?? draft.personIds;
  const pace = (n: number) => Number.isInteger(n) && n >= 1 && n <= 500;
  // What People still needs, named once each, instead of a button that will not say why it waits.
  const missing = [
    !draft.name.trim() && 'a campaign name',
    !(draft.startDate && draft.endDate && draft.endDate >= draft.startDate) && 'an end date on or after the start',
    !draft.productInterest.length && 'a product',
    !draft.fos.length && 'an FO',
    !(pace(draft.defaultBatchSize) && draft.fos.every(f => pace(f.batchSize))) && 'new people a day between 1 and 500',
    !draft.personIds.length && 'people',
  ].filter((m): m is string => !!m);
  const basicsValid = missing.length === 0;
  const startPassed = !!draft.startDate && draft.startDate < today;
  const startToday = () => patch({ startDate: today, endDate: draft.endDate < today ? today : draft.endDate });
  // A window of only a weekend is said under the dates, with the nearest working day to end on.
  const firstWorkingDay = weekendOnly(draft.startDate, draft.endDate);
  const noWorkingDays = !!firstWorkingDay;
  const inspect = async (value: CampaignDraft) => {
    const request = ++generation.current; setChecking(true); setError(null);
    const r = await previewCalendarAction(value, id);
    if (request !== generation.current) return;
    setChecking(false);
    if (r.ok) { setReview(r.data); reviewedKey.current = JSON.stringify(value); } else { setReview(null); setError(r.error); }
  };
  useEffect(() => {
    if (tab !== 1) return;
    const parsed = CampaignDraftSchema.safeParse(draft);
    if (!parsed.success) { setChecking(false); setReview(null); setError([...new Set(parsed.error.issues.map(i => i.message))].join(' ')); return; }
    if (review && JSON.stringify(draft) === reviewedKey.current) return;
    const timer = setTimeout(() => { void inspect(draft); }, 450);
    const requests = generation;
    return () => { clearTimeout(timer); requests.current++; };
    // inspect intentionally uses the draft captured by this validation request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, tab, id]);
  useEffect(() => { if (tab === 0 && review && !review.calendar.valid && review.stage === 'people') feedback.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [review, tab]);

  /** Plan from the People inputs: the server leaves out who it must, fits paces and, until someone edits it, the outreach. */
  const plan = async (next: CampaignDraft, then?: () => void) => {
    setError(null); setHold(null); setPlanning(true);
    const r = await prepareStudioAction(next, id, reshapes(next));
    setPlanning(false);
    if (!r.ok) { setError(r.error); return null; }
    // A built outreach comes with who is on which of its groups (an FO's own outreach, when one was needed).
    const merged = r.data.calendar.valid && reshapes(next) ? { ...next, flows: r.data.draft.flows, assignments: r.data.draft.assignments } : next;
    if (merged !== draft) change(merged);
    setReview(r.data); reviewedKey.current = JSON.stringify(merged);
    if (!r.data.calendar.valid && r.data.stage !== 'outreach') return r.data;
    checkedPeople.current = peopleKey(merged);
    then?.();
    return r.data;
  };
  // Why Next waits, said beside it.
  const nextOutreach = () => {
    if (!basicsValid) { setHold(`Still needed: ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0]}.`); return; }
    if (startPassed) { setHold('The start date has passed.'); return; }
    if (noWorkingDays) { setHold('Pick dates with a working day to continue.'); return; }
    void plan(draft, () => setTab(1));
  };
  const go = (to: number) => {
    if (to < tab) { setTab(to); setError(null); return; }
    if (to === 1 && tab === 0) { nextOutreach(); return; }
    if (to === 2 && tab === 0) return;
    if (to === 2 && tab === 1 && review?.calendar.valid && !checking && checkedPeople.current === peopleKey(draft)) { setTab(2); setError(null); }
  };
  const saveDraft = () => start(async () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); setError(null); await persist(); });
  const publish = () => start(async () => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    setError(null);
    const ok = await persist({ publish: true, fingerprint: review?.fingerprint });
    if (ok) { router.push(`/campaigns/${idRef.current}`); router.refresh(); return; }
    // A changed CRM detail or another campaign moved the plan: show the new one to review.
    const r = await previewCalendarAction(latest.current, idRef.current);
    if (r.ok) { setReview(r.data); checkedPeople.current = peopleKey(latest.current); }
  });
  const editOutreach = (part: Partial<CampaignDraft>) => patch({ ...part, outreachEdited: true });
  const commitGroup = () => {
    const available = subset.filter(p => plannedIds.includes(p) && (!draft.assignments[p] || draft.assignments[p] === 'default' || draft.assignments[p] === groupEditor));
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
  // Every applied fix is planned again where it was chosen, and can be taken back. A plan that
  // can no longer be shown on Schedule sends the page to the step that has to change.
  const fixed = (s: CalendarSuggestion) => s.studio ? 'The studio set the outreach.' : `Changed: ${s.label}.`;
  const showPlan = (r: Review | null) => { if (r && !r.calendar.valid && tab === 2) setTab(r.stage === 'people' ? 0 : 1); };
  const applySuggestion = async (s: CalendarSuggestion) => {
    const before = draft;
    if (s.studio) setActiveFlow('default');
    const r = await plan(s.draft);
    if (r) { setUndo({ label: fixed(s), draft: before }); showPlan(r); }
  };
  // The undo stays until its own plan is in, so a failed request can be tried again.
  const undoFix = async () => { if (!undo) return; const r = await plan(undo.draft); if (r) { setUndo(null); if (!r.calendar.valid) setTab(r.stage === 'people' ? 0 : 1); } };
  const addFo = (foId: string) => { void plan({ ...draft, fos: [...draft.fos, { id: foId, batchSize: draft.defaultBatchSize }] }); };
  const untick = (ids: string[]) => { void plan({ ...draft, fos: draft.fos.filter(f => !ids.includes(f.id)) }); };
  const updateCalendar = (next: CampaignDraft, fix?: CalendarSuggestion) => start(async () => {
    const before = draft;
    setQuickError(null); setQuickReview(null);
    const r = await prepareStudioAction(next, id, reshapes(next));
    if (!r.ok) { setQuickError(r.error); return; }
    if (!r.data.calendar.valid) { setQuickReview(r.data); return; }
    const merged = reshapes(next) ? { ...next, flows: r.data.draft.flows, assignments: r.data.draft.assignments } : next;
    change(merged); checkedPeople.current = peopleKey(merged); setReview(r.data); reviewedKey.current = JSON.stringify(merged); setQuickDraft(null);
    // Undo takes back the new dates too, so it names them.
    if (fix) setUndo({ label: 'Dates and limits changed.', draft: before });
  });
  const quickWeekend = quickDraft ? weekendOnly(quickDraft.startDate, quickDraft.endDate) : null;
  const steps = ['People', 'Outreach', 'Schedule'];
  const savable = useMemo(() => CampaignDraftSaveSchema.safeParse(draft).success, [draft]);
  const saveLabel = saveState === 'saving' || (canAutosave && dirty.current && savable && saveState !== 'failed') ? 'Saving draft…' : saveState === 'failed' || (canAutosave && dirty.current && !savable) ? 'Not saved' : saveState === 'saved' || (canAutosave && id && !dirty.current) ? 'Draft saved' : null;
  return <div className="space-y-5 pb-4">
    <header className="surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><span className="text-xs font-semibold uppercase tracking-widest text-brand-700">Campaign studio</span><h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-900">{draft.name || 'Build your next conversation'}</h1></div><div className="flex items-center gap-3">{saveLabel && <span role="status" className={`text-sm ${saveState === 'failed' ? 'text-red-700' : 'text-ink-500'}`}>{saveLabel}</span>}{(!canAutosave || saveState === 'failed') && <button type="button" className="btn-secondary" disabled={pending} onClick={saveDraft}>{canAutosave ? 'Retry save' : 'Save draft'}</button>}</div></div>
      <nav aria-label="Campaign setup" className="mt-6 grid grid-cols-3 gap-1 sm:flex sm:gap-2">{steps.map((name, i) => <button type="button" key={name} disabled={pending || planning || (i === 2 && tab !== 2 && (tab !== 1 || !review?.calendar.valid || checking))} aria-current={tab === i ? 'step' : undefined} onClick={() => go(i)} className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-xs sm:gap-2 sm:px-4 sm:text-sm ${tab === i ? 'bg-ink-900 font-semibold text-white shadow-sm' : 'bg-white/70 font-medium text-ink-500 hover:bg-white'}`}><span className="opacity-60">0{i + 1}</span>{name}</button>)}</nav>
    </header>
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"><div className="min-w-0 flex-1"><span className="block font-medium text-red-900">{error === lastSaveError.current ? 'Not saved' : "Can't continue yet"}</span><p className="mt-1 text-sm text-red-800">{error}</p></div></div>}
    {tab > 0 && planned && view && <PlanSummary review={view} pod={pod} onAddFo={addFo} onUntick={untick} onApply={applySuggestion} busy={pending || planning || stale} undo={undo && <UndoLine label={undo.label} busy={pending || planning} onUndo={() => { void undoFix(); }} />} />}
    {undo && !(tab > 0 && planned && view) && <div className="surface px-5 py-3 text-sm"><UndoLine label={undo.label} busy={pending || planning} onUndo={() => { void undoFix(); }} /></div>}
    <fieldset disabled={pending || planning} className="min-w-0 space-y-5">
    {tab === 0 && <>
      <section className="surface grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-4">
        <Field label="Campaign name" required><input aria-label="Campaign name" value={draft.name} onChange={e => patch({ name: e.target.value })} className="w-full" /></Field>
        <Field label="Pod" required><select aria-label="Campaign pod" value={draft.podId} onChange={e => { const p = pods.find(p => p.id === e.target.value)!; patch({ podId: p.id, fos: [], personIds: [], assignments: {}, foAssignments: undefined }); }} className="w-full">{pods.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Start date" required><input aria-label="Start date" type="date" value={draft.startDate} onChange={e => patch({ startDate: e.target.value })} className={`w-full ${startPassed ? '!border-red-300' : ''}`} />{startPassed && <p className="mt-1 text-xs text-red-700">This date has passed. <button type="button" className="font-medium text-brand-700 hover:underline" onClick={startToday}>Use today</button></p>}</Field>
        <Field label="End date" required><input aria-label="End date" type="date" value={draft.endDate} min={draft.startDate} onChange={e => patch({ endDate: e.target.value })} className={`w-full ${noWorkingDays ? '!border-amber-300' : ''}`} />{noWorkingDays && !startPassed && <p className="mt-1 text-xs text-amber-800">No working days in these dates. <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => patch({ endDate: firstWorkingDay })}>End on {shortDateLabel(firstWorkingDay)}</button></p>}</Field>
        <div className="md:col-span-2 lg:col-span-4"><span className="mb-2 block text-sm font-medium">Products</span><div className="flex flex-wrap gap-2">{products.map(p => <button key={p} type="button" aria-pressed={draft.productInterest.includes(p)} onClick={() => patch({ productInterest: draft.productInterest.includes(p) ? draft.productInterest.filter(x => x !== p) : [...draft.productInterest, p] })} className={draft.productInterest.includes(p) ? 'chip' : 'chip-muted !border !border-line'}>{optionLabel(p)}</button>)}</div></div>
      </section>
      <section className="surface p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Who will run this campaign?</h2><label className="flex items-center gap-3 text-sm">New people a day<input aria-label="Default new people per day" className="!w-20 !font-medium" type="number" min={1} max={500} value={draft.defaultBatchSize || ''} onChange={e => { const n = Number(e.target.value); patch({ defaultBatchSize: n, fos: draft.fos.map(f => f.batchSize === draft.defaultBatchSize ? { ...f, batchSize: n } : f) }); }} /></label></div>{pod && !pod.fos.length && <p className="text-sm text-ink-500">No FOs work in {pod.name}.</p>}<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{pod?.fos.map(fo => { const selected = draft.fos.find(f => f.id === fo.id); return <div key={fo.id} className={`flex items-center justify-between gap-2 rounded-xl border p-3 ${selected ? 'border-brand-200 bg-brand-50/40' : 'border-line'}`}><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={!!selected} onChange={() => patch({ fos: selected ? draft.fos.filter(f => f.id !== fo.id) : [...draft.fos, { id: fo.id, batchSize: draft.defaultBatchSize }] })} />{fo.name}{selected && review?.droppedFos.some(d => d.id === fo.id) && <span className="text-xs font-normal text-ink-500">Not in this plan</span>}</label>{selected && <input type="number" aria-label={`${fo.name} new people per day`} min={1} max={500} value={selected.batchSize || ''} className="!w-20 !font-medium" onChange={e => patch({ fos: draft.fos.map(f => f.id === fo.id ? { ...f, batchSize: Number(e.target.value) } : f) })} />}</div>; })}</div></section>
      <section className="surface p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Your audience <span className="ml-2 rounded-full bg-brand-50 px-2 py-1 font-medium text-brand-800">{draft.personIds.length}</span></h2></div><PeoplePicker campaignPodId={draft.podId} campaignFoIds={draft.fos.map(f => f.id)} campaignId={id} key={draft.podId} initialPod={pod?.podOwnerValue} value={draft.personIds} onChange={personIds => { setSubset(s => s.filter(id => personIds.includes(id))); patch({ personIds, assignments: Object.fromEntries(Object.entries(draft.assignments).filter(([id]) => personIds.includes(id))) }); }} /></section>
    </>}
    {tab === 0 && review && !review.calendar.valid && review.stage === 'people' && <div ref={feedback} className="space-y-3"><PlannerFeedback review={review} onApply={applySuggestion} busy={pending || planning} />{review.leftOut.length > 0 && <LeftOutList leftOut={review.leftOut} pod={pod} onAddFo={addFo} busy={pending} />}</div>}
    {tab === 1 && view && !view.calendar.valid && <div ref={feedback} className="scroll-mt-4"><PlannerFeedback review={view} onApply={applySuggestion} onBack={() => setTab(0)} busy={pending || planning || stale} /></div>}
    {tab === 1 && <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="surface space-y-2 p-3 lg:sticky lg:top-4" aria-label="Outreach groups">
        <h2 className="px-2 py-2 font-semibold">Outreach groups</h2>
        {draft.flows.map(f => <div key={f.id} className={`rounded-lg border p-3 ${flow.id === f.id ? 'border-brand-300 bg-brand-50/40' : 'border-line'}`}>
          <div className="flex items-center gap-2"><button type="button" onClick={() => setActiveFlow(f.id)} className="min-w-0 flex-1 truncate text-left text-sm font-semibold">{f.name || 'Untitled outreach'}</button>{f.id !== 'default' && <button type="button" className="btn-icon-ghost text-ink-500 hover:text-red-700" aria-label={`Delete ${f.name || 'untitled outreach'}`} onClick={() => removeGroup(f.id)}><IconTrash size={14} /></button>}</div>
          {flow.id === f.id && f.id !== 'default' && <input aria-label="Outreach group name" className="mt-2 w-full !text-sm" placeholder="Name this outreach" value={f.name} onChange={e => editOutreach({ flows: draft.flows.map(x => x.id === f.id ? { ...x, name: e.target.value } : x) })} />}
          <div className="mt-2 flex items-center justify-between text-xs text-ink-600"><span><span className="font-medium text-ink-900 tabular-nums">{plannedIds.filter(id => (draft.assignments[id] ?? 'default') === f.id).length}</span> {plannedIds.filter(id => (draft.assignments[id] ?? 'default') === f.id).length === 1 ? 'person' : 'people'}</span><span><span className="font-medium text-ink-900 tabular-nums">{f.steps.length}</span> {f.steps.length === 1 ? "step" : "steps"}</span></div>
          {f.id !== 'default' && <button type="button" className="mt-2 text-xs font-medium text-brand-700 hover:underline" onClick={() => { setSubset(plannedIds.filter(id => draft.assignments[id] === f.id)); setGroupEditor(f.id); }}>Manage people</button>}
        </div>)}
        <button type="button" className="btn-secondary w-full" disabled={draft.flows.length >= 30 || plannedIds.every(id => draft.assignments[id] && draft.assignments[id] !== 'default')} onClick={() => { setSubset([]); setGroupEditor('new'); }}><IconPlus size={14} /> Add outreach group</button>
      </aside>
      <div className="min-w-0 space-y-4">
        <h2 className="text-lg font-semibold">{flow.name || 'Untitled outreach'}</h2>
        <section className="surface p-4"><OutreachBuilder key={flow.id} steps={flow.steps} maxSteps={Math.min(stepLimits.current[flow.id] ?? 60, calendarDays(draft.startDate, draft.endDate).length)} onChange={steps => editOutreach({ flows: draft.flows.map(f => f.id === flow.id ? { ...f, steps } : f) })} /></section>
      </div>
    </div>}
    {tab === 2 && planned && review && <section className="surface p-4 sm:p-5">
      <CampaignCalendarView draft={planned} calendar={review.calendar} actions={<><button type="button" className="btn-secondary btn-sm" onClick={() => { setQuickDraft(structuredClone(draft)); setQuickReview(null); setQuickError(null); }}>Dates and limits</button><button type="button" className="btn-secondary btn-sm" onClick={() => setTab(1)}>Edit outreach</button></>} />
    </section>}
    </fieldset>
    {groupEditor && <Modal label={groupEditor === 'new' ? 'Add outreach group' : 'Manage group people'} onClose={() => setGroupEditor(null)}><div className="space-y-4 p-5"><h2 className="text-lg font-semibold">{groupEditor === 'new' ? 'Add outreach group' : 'Manage group people'}</h2><p className="text-sm text-ink-600">Choose people from Default. People in another custom group are unavailable.</p><PeoplePicker campaignPodId={draft.podId} campaignFoIds={draft.fos.map(f => f.id)} campaignId={id} withinIds={plannedIds} disabledIds={plannedIds.filter(id => draft.assignments[id] && draft.assignments[id] !== 'default' && draft.assignments[id] !== groupEditor)} value={subset} onChange={setSubset} /><div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setGroupEditor(null)}>Cancel</button><button type="button" className="btn-primary" disabled={!subset.length} onClick={commitGroup}>{groupEditor === 'new' ? 'Create outreach group' : 'Save people'} ({subset.length})</button></div></div></Modal>}
    {quickDraft && <Modal label="Dates and limits" onClose={() => setQuickDraft(null)}><div className="space-y-4 p-5"><h2 className="text-lg font-semibold">Dates and limits</h2><div className="grid grid-cols-2 gap-3"><Field label="Start date"><input aria-label="Adjust start date" type="date" value={quickDraft.startDate} onChange={e => { setQuickDraft({ ...quickDraft, startDate: e.target.value }); setQuickReview(null); }} /></Field><Field label="End date"><input aria-label="Adjust end date" type="date" value={quickDraft.endDate} onChange={e => { setQuickDraft({ ...quickDraft, endDate: e.target.value }); setQuickReview(null); }} />{quickWeekend && <p className="mt-1 text-xs text-amber-800">No working days in these dates. <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => { setQuickDraft({ ...quickDraft, endDate: quickWeekend }); setQuickReview(null); }}>End on {shortDateLabel(quickWeekend)}</button></p>}</Field></div>{quickDraft.fos.length > 0 && <div className="flex justify-between text-xs font-medium text-ink-500"><span>FO</span><span>New people a day</span></div>}{quickDraft.fos.map(f => <label key={f.id} className="flex items-center justify-between gap-3 text-sm">{pod?.fos.find(fo => fo.id === f.id)?.name}<input aria-label={`Adjust ${pod?.fos.find(fo => fo.id === f.id)?.name ?? 'FO'} new people per day`} className="!w-20 !font-medium" type="number" min={1} max={500} value={f.batchSize || ''} onChange={e => { setQuickDraft({ ...quickDraft, fos: quickDraft.fos.map(fo => fo.id === f.id ? { ...fo, batchSize: Number(e.target.value) } : fo) }); setQuickReview(null); }} /></label>)}{quickError && <p role="alert" className="text-sm text-red-700">{quickError}</p>}{quickReview && <PlannerFeedback review={quickReview} onApply={s => updateCalendar(s.draft, s)} busy={pending} />}<div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setQuickDraft(null)}>Cancel</button><button type="button" className="btn-primary" disabled={pending || !!quickReview || !!quickWeekend} onClick={() => updateCalendar(quickDraft)}>Update calendar</button></div></div></Modal>}
    <footer className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white/95 p-4 shadow-sm backdrop-blur">
      <span className="min-w-0 flex-1 text-sm text-ink-600">{tab === 0
        ? hold ? <span role="alert" className="flex items-center gap-2 text-amber-800"><IconAlert size={15} />{hold}</span> : <FooterCount people={draft.personIds.length} fos={draft.fos.length} />
        : tab === 1 && (checking || (!review && !error)) ? 'Checking…'
        : tab === 1 && review && !review.calendar.valid ? <span className="flex flex-wrap items-center gap-3"><span className="flex items-center gap-2 text-amber-800"><IconAlert size={15} />Fix the plan above to continue.</span><button type="button" className="btn-secondary btn-sm" onClick={() => feedback.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>See how to fix</button></span>
        : null}</span>
      <div className="flex gap-2">{tab > 0 && <button type="button" disabled={pending || planning} className="btn-secondary" onClick={() => go(tab - 1)}>Back</button>}{tab === 0 ? <button type="button" className="btn-primary" disabled={pending || planning} onClick={nextOutreach}>{planning ? 'Planning…' : 'Next: Outreach'}</button> : tab === 1 ? <button type="button" disabled={pending || planning || checking || !review?.calendar.valid} className="btn-primary" onClick={() => go(2)}>{checking || planning ? 'Checking…' : 'Next: Schedule'}</button> : <button type="button" disabled={pending || planning || !review?.calendar.valid} className="btn-primary" onClick={canPublish ? publish : saveDraft}>{canPublish ? 'Publish campaign' : 'Save for leader review'}</button>}</div>
    </footer>
  </div>;
}

const list = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];

function FooterCount({ people, fos }: { people: number; fos: number }) {
  return <><span className="font-medium text-ink-900 tabular-nums">{people.toLocaleString('en-US')}</span> {people === 1 ? 'person' : 'people'} · <span className="font-medium text-ink-900 tabular-nums">{fos}</span> {fos === 1 ? 'FO' : 'FOs'}</>;
}

/** What the planner did with the request: who is in, each FO's pace, and who was left out. */
/** The last applied fix, with the way back. */
function UndoLine({ label, busy, onUndo }: { label: string; busy: boolean; onUndo: () => void }) {
  return <span role="status" className="flex items-center gap-2 text-ink-900"><IconCheck size={15} className="text-brand-700" />{label}<button type="button" className="btn-ghost btn-sm" aria-label="Undo this change" disabled={busy} onClick={onUndo}>Undo</button></span>;
}

/** Only a weekend (or one weekend day) between these dates: the first working day after the start, else null. */
function weekendOnly(start: string, end: string) {
  if (!start || !end || end < start || calendarDays(start, end).length) return null;
  let d = start; while (!workingDay(d)) d = addDays(d, 1);
  return d;
}

function PlanSummary({ review, pod, onAddFo, onUntick, onApply, busy, undo }: { review: Review; pod?: WorkspacePod; onAddFo: (id: string) => void; onUntick: (ids: string[]) => void; onApply: (s: CalendarSuggestion) => void; busy: boolean; undo?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const planned = review.draft.personIds.length;
  return <section className="surface" aria-label="Plan">
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm text-ink-600">
      <span>{review.leftOut.length > 0 ? <><span className="font-medium text-ink-900 tabular-nums">{planned.toLocaleString('en-US')}</span> of <span className="tabular-nums">{(planned + review.leftOut.length).toLocaleString('en-US')}</span> planned</> : <><span className="font-medium text-ink-900 tabular-nums">{planned.toLocaleString('en-US')}</span> {planned === 1 ? 'person' : 'people'} planned</>}</span>
      {review.leftOut.length > 0 && <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-ink-900 hover:underline"><span className="font-medium tabular-nums">{review.leftOut.length.toLocaleString('en-US')}</span> left out<IconChevronRight size={13} className={open ? 'rotate-90' : undefined} /></button>}
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1"><span className="text-ink-500">New people a day:</span>{[...new Set(review.paces.map(p => `${p.from}>${p.to}`))].map(key => { const group = review.paces.filter(p => `${p.from}>${p.to}` === key); const [from, to] = [group[0].from, group[0].to]; return <span key={key}>{list(group.map(p => p.name))} <span className="tabular-nums">{from !== to && <span className="text-ink-400">{from} → </span>}<span className={`font-medium ${to > from ? 'text-amber-700' : 'text-ink-900'}`}>{to}</span></span></span>; })}</span>
      {[...new Set(review.droppedFos.map(f => f.reason))].map(reason => { const off = review.droppedFos.filter(f => f.reason === reason); return <span key={reason} className="flex flex-wrap items-center gap-2 text-ink-900">{list(off.map(f => f.name))} {off.length > 1 ? 'are' : 'is'} not in this plan: {reason}.<button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => onUntick(off.map(f => f.id))}>Remove {off.length > 1 ? 'them' : off[0].name}</button></span>; })}
      {undo && <span className="ml-auto">{undo}</span>}
    </div>
    {review.suggestions.length > 0 && <div className="border-t border-line"><p className="px-5 pt-3 text-sm font-medium text-ink-900">To fit everyone in</p><Fixes suggestions={review.suggestions} onApply={onApply} busy={busy} /></div>}
    {open && <div className="border-t border-line"><LeftOutList leftOut={review.leftOut} pod={pod} onAddFo={onAddFo} busy={busy} flat /></div>}
  </section>;
}

function LeftOutList({ leftOut, pod, onAddFo, busy, flat = false }: { leftOut: LeftOut[]; pod?: WorkspacePod; onAddFo: (id: string) => void; busy: boolean; flat?: boolean }) {
  const groups = [...leftOut.reduce((m, p) => { const g = m.get(p.reason) ?? { reason: p.reason, ownerId: p.ownerId, people: [] as LeftOut[] }; g.people.push(p); return m.set(p.reason, g); }, new Map<string, { reason: string; ownerId?: string; people: LeftOut[] }>()).values()].sort((a, b) => b.people.length - a.people.length);
  return <div className={`${flat ? '' : 'surface'} divide-y divide-line`} aria-label="Left out">
    {groups.map(g => <LeftOutGroup key={g.reason} reason={g.reason} people={g.people} owner={g.ownerId ? pod?.fos.find(f => f.id === g.ownerId) : undefined} onAddFo={onAddFo} busy={busy} />)}
  </div>;
}

function LeftOutGroup({ reason, people, owner, onAddFo, busy }: { reason: string; people: LeftOut[]; owner?: { id: string; name: string }; onAddFo: (id: string) => void; busy: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? people : people.slice(0, 12);
  return <div className="px-5 py-3">
    <div className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium text-ink-900">{reason}</span><span className="text-xs tabular-nums text-ink-500">{people.length.toLocaleString('en-US')}</span>{owner && <button type="button" className="btn-secondary btn-sm ml-auto" disabled={busy} onClick={() => onAddFo(owner.id)}>Add {owner.name}</button>}</div>
    <div className="mt-1.5 grid grid-cols-4 gap-x-6 gap-y-1 text-[13px] text-ink-700">{shown.map(p => <a key={p.id} href={`/people/${p.id}`} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:text-ink-900 hover:underline">{p.name}{p.company ? <span className="text-ink-400"> · {p.company}</span> : null}</a>)}{people.length > shown.length && <button type="button" className="text-left text-brand-700 hover:underline" onClick={() => setAll(true)}>+{(people.length - shown.length).toLocaleString('en-US')} more</button>}</div>
  </div>;
}

const feedbackHeading = (review: Review) => review.stage === 'outreach' ? "Your outreach doesn't fit these dates yet" : "This campaign can't be planned yet";

/** What to try when none of the checked fixes works, by what stands in the way. */
function lastResort(review: Review) {
  const kinds = new Set(review.calendar.issues.map(i => i.kind));
  if (kinds.has('window')) return 'Try removing a step, shortening the waits, or choosing a later end date.';
  if (kinds.has('many')) return 'Try a later end date, or fewer steps.';
  if (kinds.has('few')) return 'Try adding steps, an earlier end date, or more people in People.';
  return 'Try different waits between steps, or a later end date.';
}

/** Why the plan cannot be made, in plain words, then the fixes the planner checked will work. */
function PlannerFeedback({ review, onApply, onBack, busy }: { review: Review; onApply: (s: CalendarSuggestion) => void; onBack?: () => void; busy: boolean }) {
  const issues = review.calendar.issues;
  const one = issues.length === 1 ? issues[0] : null;
  return <section aria-label="Adjust this plan" aria-live="polite" className="overflow-hidden rounded-xl border border-amber-200 bg-white text-sm shadow-sm">
    <div className="flex items-start gap-3 bg-amber-50 px-5 py-4">
      <IconAlert size={18} className="mt-0.5 shrink-0 text-amber-700" />
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-ink-900">{one ? one.title.replace(/\.$/, '') : feedbackHeading(review)}</h3>
        {one ? one.detail && <p className="mt-1 text-ink-700">{one.detail}</p>
          : <ul className="mt-2 list-disc space-y-2 pl-4 marker:text-amber-700">{issues.map((issue, i) => <li key={i}><p className="text-ink-900">{issue.title}</p>{issue.detail && <p className="mt-0.5 text-ink-700">{issue.detail}</p>}</li>)}</ul>}
      </div>
      {onBack && review.stage === 'people' && <button type="button" className="btn-secondary btn-sm shrink-0" onClick={onBack}>Back to People</button>}
    </div>
    {review.suggestions.length > 0 ? <Fixes suggestions={review.suggestions} onApply={onApply} busy={busy} /> : review.stage === 'outreach' && <p className="border-t border-amber-100 px-5 py-3 text-ink-600">None of the quick fixes work here. {lastResort(review)}</p>}
  </section>;
}

/** The studio's own outreach first, as the recommended fix; then the small changes, each checked to work. */
function Fixes({ suggestions, onApply, busy }: { suggestions: CalendarSuggestion[]; onApply: (s: CalendarSuggestion) => void; busy: boolean }) {
  const studio = suggestions.find(s => s.studio);
  const others = suggestions.filter(s => !s.studio);
  return <div className="text-sm">
    {studio && <div className="px-5 pt-4 last:pb-4"><div className="flex flex-wrap items-center gap-4 rounded-lg border border-brand-200 bg-brand-50/70 p-4">
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-brand-700 ring-1 ring-brand-200"><IconBolt size={17} /></span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-semibold text-ink-900">{studio.label}<span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-brand-700 ring-1 ring-brand-200">Recommended</span></p>
        <p className="mt-1 text-ink-700">{studio.detail}</p>
        <p className="mt-1 text-ink-500">Replaces your steps, messages and any outreach groups you added. You can undo.</p>
      </div>
      <button type="button" className="btn-primary shrink-0" disabled={busy} onClick={() => onApply(studio)}>Set it for me</button>
    </div></div>}
    {others.length > 0 && <div className="px-5 pb-2 pt-3">
      <p className="text-xs font-medium text-ink-500">{studio ? 'Or make one smaller change' : others.length === 1 ? 'This fixes it' : 'Any one of these fixes it'}</p>
      <ul className="divide-y divide-line">{others.map((s, i) => <li key={i} className="flex items-center justify-between gap-4 py-2.5"><div className="min-w-0"><p className="font-medium text-ink-900">{s.label}</p>{s.detail && <p className="mt-0.5 text-ink-600">{s.detail}</p>}</div><button type="button" className="btn-secondary btn-sm shrink-0" disabled={busy} onClick={() => onApply(s)}>Apply</button></li>)}</ul>
    </div>}
  </div>;
}
