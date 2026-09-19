'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PeoplePicker } from './people-picker';
import { ENROLL_CONFLICT_LABELS } from '@/lib/campaign-status';
import { createCampaignAction, planCampaignAction, previewCampaignAction, type CampaignPreview, type CapacitySummary } from '@/lib/actions/campaigns';
import type { ActionResult } from '@/lib/actions/users';
import { optionLabel } from '@/lib/twenty/labels';
import { Badge, Card, Count, Field, Notice } from '@/components/ui';

type Props = {
  sequences: { id: string; name: string; durationDays: number }[];
  pods: { id: string; name: string; podOwnerValue: string }[];
  products: string[];
  defaultStartDate: string;
  defaultEndDate: string;
  /** People chosen on the People list before coming here. */
  initialIds?: string[];
};

/**
 * Two columns: the campaign on the left, its people on the right, and under both who would start
 * - worked out as the form changes, not on a button. The window's capacity sits under the dates
 * and turns red the moment the audience is bigger than it, naming the end date that would fit.
 */
export function CampaignForm({ sequences, pods, products, defaultStartDate, defaultEndDate, initialIds = [] }: Props) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [fields, setFields] = useState({ name: '', sequenceId: sequences[0]?.id ?? '', podId: pods[0]?.id ?? '', startDate: defaultStartDate, endDate: defaultEndDate, description: '', startsPerFoPerDay: '' });
  const [chosenProducts, setChosenProducts] = useState<string[]>([]);
  const [sourceType, setSourceType] = useState<'PICK' | 'CSV'>('PICK');
  const [csvText, setCsvText] = useState('');
  const [csvName, setCsvName] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(initialIds);
  const [plan, setPlan] = useState<CapacitySummary | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [showAll, setShowAll] = useState(false);

  const audience = sourceType === 'CSV' ? (csvText ? csvText.split('\n').filter((l) => l.trim()).length - 1 : 0) : picked.length;
  const set = (patch: Partial<typeof fields>) => setFields((f) => ({ ...f, ...patch }));

  const collect = () => {
    const fd = new FormData(formRef.current!);
    fd.set('sourceType', sourceType);
    fd.set('personIds', JSON.stringify(sourceType === 'PICK' ? picked : []));
    fd.set('csvText', sourceType === 'CSV' ? csvText : '');
    fd.set('audience', String(Math.max(0, audience)));
    return fd;
  };

  // The window's capacity, as the fields change.
  useEffect(() => {
    if (!fields.sequenceId || !fields.podId || !fields.startDate || !fields.endDate) return;
    const t = setTimeout(async () => {
      const r = await planCampaignAction(collect());
      if (r.ok) { setPlan(r.data as CapacitySummary); setPlanError(null); }
      else { setPlan(null); setPlanError(r.error); }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.sequenceId, fields.podId, fields.startDate, fields.endDate, fields.startsPerFoPerDay, audience]);

  // Who starts, as the audience changes.
  useEffect(() => {
    if (!fields.sequenceId || !fields.podId || !fields.startDate || !fields.endDate || audience <= 0) { setPreview(null); return; }
    const t = setTimeout(() => start(async () => {
      const r = await previewCampaignAction(collect());
      if (r.ok) { setPreview(r.data as CampaignPreview); setPreviewError(null); }
      else { setPreview(null); setPreviewError(r.error); }
    }), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.sequenceId, fields.podId, fields.startDate, fields.endDate, fields.startsPerFoPerDay, picked, csvText, sourceType, chosenProducts.length]);

  const create = () =>
    start(async () => {
      const r = await createCampaignAction(collect());
      setResult(r);
      if (r.ok && r.redirectTo) router.push(r.redirectTo);
    });

  const sequence = sequences.find((s) => s.id === fields.sequenceId);
  const noRoom = preview?.conflicts.filter((c) => c.reason === 'no_room').length ?? 0;
  const overCapacity = plan ? audience > plan.total : false;
  const canCreate = Boolean(preview && preview.candidates.length > 0 && noRoom === 0 && plan && !plan.tooShort && chosenProducts.length > 0 && fields.name.trim());
  const rates = plan ? [...new Set(plan.perFo.map((f) => f.rate))] : [];
  const rateText = rates.length === 1 ? `${rates[0]} starts a day per FO` : rates.length ? `${Math.min(...rates)}–${Math.max(...rates)} starts a day per FO` : null;

  return (
    <form ref={formRef} onSubmit={(e) => e.preventDefault()} className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card title="Campaign">
          <div className="space-y-4 p-5">
            <Field label="Name" required>
              <input name="name" value={fields.name} onChange={(e) => set({ name: e.target.value })} required className="w-full" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Sequence" required>
                <select name="sequenceId" value={fields.sequenceId} onChange={(e) => set({ sequenceId: e.target.value })} required className="w-full">
                  {sequences.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.durationDays} days</option>)}
                </select>
              </Field>
              <Field label="Pod" required>
                <select name="podId" value={fields.podId} onChange={(e) => set({ podId: e.target.value })} required className="w-full">
                  {pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Product" required>
              <div className="flex flex-wrap gap-1.5">
                {products.map((p) => {
                  const on = chosenProducts.includes(p);
                  return (
                    <button key={p} type="button" aria-pressed={on} onClick={() => setChosenProducts((c) => (on ? c.filter((x) => x !== p) : [...c, p]))} className={on ? 'chip' : 'chip-muted !border !border-line'}>
                      {optionLabel(p)}
                    </button>
                  );
                })}
                {chosenProducts.map((p) => <input key={p} type="hidden" name="productInterest" value={p} />)}
              </div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start date" required>
                <input name="startDate" type="date" value={fields.startDate} onChange={(e) => set({ startDate: e.target.value })} required className="w-full" />
              </Field>
              <Field label="End date" required>
                <input name="endDate" type="date" value={fields.endDate} min={fields.startDate} onChange={(e) => set({ endDate: e.target.value })} required className="w-full" />
              </Field>
            </div>
            {/* The window's capacity: live numbers, red when the audience does not fit. */}
            <div role="status" className={`rounded-lg px-3 py-2.5 text-[12.5px] ${planError || plan?.tooShort || overCapacity ? 'border border-red-200 bg-red-50/70 text-red-800' : 'bg-canvas text-ink-700'}`}>
              {planError ? planError : !plan ? <span className="text-ink-400">Working out the window…</span> : plan.tooShort ? (
                <>This sequence spans <span className="font-medium">{plan.durationDays}</span> days; the campaign runs {fields.startDate} to {fields.endDate}.{plan.endDateThatFits ? <> Ending on <button type="button" className="font-medium underline" onClick={() => set({ endDate: plan.endDateThatFits! })}>{plan.endDateThatFits}</button> would fit.</> : null}</>
              ) : (
                <>
                  Room for <span className="font-medium">{plan.total.toLocaleString('en-US')}</span> people{rateText ? <> · {rateText}</> : null}
                  {overCapacity ? <span className="block pt-1">You chose {audience.toLocaleString('en-US')}.{plan.endDateThatFits ? <> Ending on <button type="button" className="font-medium underline" onClick={() => set({ endDate: plan.endDateThatFits! })}>{plan.endDateThatFits}</button> would take them all, or</> : ' Even a year would not take them all;'} trim the audience by {(audience - plan.total).toLocaleString('en-US')}.</span> : null}
                </>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starts per FO per day">
                <input name="startsPerFoPerDay" type="number" min={1} max={500} value={fields.startsPerFoPerDay} onChange={(e) => set({ startsPerFoPerDay: e.target.value })} placeholder={rates.length === 1 ? String(rates[0]) : ''} className="w-full" />
              </Field>
            </div>
            <Field label="Description">
              <textarea name="description" rows={3} value={fields.description} onChange={(e) => set({ description: e.target.value })} className="w-full" />
            </Field>
          </div>
        </Card>

        <Card title="People" actions={
          <span className="flex gap-1 text-[12.5px]">
            <button type="button" className={sourceType === 'PICK' ? 'chip' : 'chip-muted'} aria-pressed={sourceType === 'PICK'} onClick={() => setSourceType('PICK')}>Pick from People</button>
            <button type="button" className={sourceType === 'CSV' ? 'chip' : 'chip-muted'} aria-pressed={sourceType === 'CSV'} onClick={() => setSourceType('CSV')}>Upload a list</button>
          </span>
        }>
          <div className="p-5">
            {sourceType === 'PICK' ? (
              <PeoplePicker value={picked} onChange={setPicked} />
            ) : (
              <div className="space-y-3">
                <Field label="CSV export from Twenty" required>
                  <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setCsvName(f.name); setCsvText(await f.text()); }} />
                </Field>
                {csvName ? <p className="text-[12.5px] text-ink-600">{csvName} · <Count value={Math.max(0, audience)} /> rows</p> : null}
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card title={preview ? `Who starts · ${preview.candidates.length.toLocaleString('en-US')} of ${(preview.candidates.length + preview.conflicts.length).toLocaleString('en-US')}` : 'Who starts'}>
        <div className="space-y-4 p-5">
          {previewError ? <Notice tone="error">{previewError}</Notice> : null}
          {!preview && !previewError ? <p className="text-[13px] text-ink-400">{audience > 0 ? 'Checking the audience…' : `${audience.toLocaleString('en-US')} chosen`}</p> : null}
          {preview?.note ? <Notice tone="info">{preview.note}</Notice> : null}
          {preview?.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
          {preview?.conflicts.length ? (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="table table-dense">
                <thead><tr><th>Skipped</th><th>Why</th><th>Detail</th></tr></thead>
                <tbody>
                  {(showAll ? preview.conflicts : preview.conflicts.slice(0, 25)).map((c) => (
                    <tr key={`${c.personId}-${c.reason}`}>
                      <td className="text-[13px] text-ink-900">{c.name}</td>
                      <td><Badge tone={c.reason === 'dnd' || c.reason === 'no_room' ? 'red' : 'amber'}>{ENROLL_CONFLICT_LABELS[c.reason] ?? c.reason}</Badge></td>
                      <td className="text-[12px] text-ink-600">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.conflicts.length > 25 && !showAll ? <button type="button" className="btn-ghost btn-sm m-2" onClick={() => setShowAll(true)}>Show all {preview.conflicts.length}</button> : null}
            </div>
          ) : null}
          {preview?.candidates.length ? (
            <div className="max-h-80 overflow-y-auto rounded-xl border border-line">
              <table className="table table-dense">
                <thead><tr><th>Person</th><th>Company</th><th>FO</th><th>Starts</th></tr></thead>
                <tbody>
                  {preview.candidates.slice(0, 50).map((c) => (
                    <tr key={c.personId}><td className="text-[13px] text-ink-900">{c.name}</td><td className="text-[12.5px] text-ink-700">{c.companyName}</td><td className="text-[12.5px] text-ink-700">{c.foName}</td><td className="text-[12.5px] tabular-nums text-ink-700">{c.startDate}</td></tr>
                  ))}
                </tbody>
              </table>
              {preview.candidates.length > 50 ? <div className="border-t border-line px-3 py-2 text-[12px] text-ink-500">and {(preview.candidates.length - 50).toLocaleString('en-US')} more</div> : null}
            </div>
          ) : preview ? <Notice tone="warn">Nobody in this audience can start.</Notice> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" onClick={create} disabled={pending || !canCreate}>
              {pending ? 'Working…' : preview ? `Create campaign · ${preview.candidates.length.toLocaleString('en-US')} start` : 'Create campaign'}
            </button>
            {!fields.name.trim() ? <span className="text-[12.5px] text-ink-500">Name the campaign.</span> : !chosenProducts.length ? <span className="text-[12.5px] text-ink-500">Choose a product.</span> : sequence && plan?.tooShort ? <span className="text-[12.5px] text-red-700">Extend the end date.</span> : noRoom ? <span className="text-[12.5px] text-red-700">{noRoom} have no room before the end date.</span> : null}
          </div>
          {result && !result.ok ? <Notice tone="error">{result.error}</Notice> : null}
        </div>
      </Card>
    </form>
  );
}
