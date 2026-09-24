'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { applyAddFoAction, planAddFoAction } from '@/lib/actions/campaign-add-fo';
import type { AddFoPreview } from '@/lib/campaign-add-fo';
import type { LeftOut } from '@/lib/campaign-planning-service';
import { calendarDateLabel, spacingInWords } from '@/lib/campaign-planner';
import { PeoplePicker } from './people-picker';
import { IconPlus } from '@/components/icons';

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const steps = (s: AddFoPreview['flow']['steps']) => s.length === 1 ? '1 step' : `${s.length} steps${s.every((x, i) => i === 0 || x.day - s[i - 1].day === s[1].day - s[0].day) ? `, ${spacingInWords(s[1].day - s[0].day)}` : ''}`;

/**
 * On a running campaign's start day: a new FO joins with their own people. Nobody already on the
 * campaign changes; the new part is planned, shown, and only then added.
 */
export function AddFoPanel({ campaignId, campaignName, podId, candidates, defaultPace, today }: { campaignId: string; campaignName: string; podId: string; candidates: { id: string; name: string }[]; defaultPace: number; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setFoId] = useState(candidates[0]?.id ?? '');
  // Once an FO joins they leave the list; fall back to whoever is first now.
  const foId = candidates.some((f) => f.id === picked) ? picked : candidates[0]?.id ?? '';
  const [pace, setPace] = useState(defaultPace);
  const [chosen, setChosen] = useState<string[]>([]);
  const [preview, setPreview] = useState<AddFoPreview | null>(null);
  const [leftOut, setLeftOut] = useState<LeftOut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fo = candidates.find((f) => f.id === foId);
  const reset = () => { setPreview(null); setLeftOut([]); setError(null); };
  const input = { foId, personIds: chosen, batchSize: pace };
  const plan = () => start(async () => {
    reset();
    const r = await planAddFoAction(campaignId, input);
    if (r.ok) { setPreview(r.preview); setLeftOut(r.preview.leftOut); } else { setError(r.error); setLeftOut(('leftOut' in r ? (r.leftOut as LeftOut[] | undefined) : undefined) ?? []); }
  });
  const apply = () => start(async () => {
    if (!preview) return;
    const r = await applyAddFoAction(campaignId, input, preview.fingerprint);
    if (!r.ok) { setError(r.error); setPreview(null); return; }
    const first = preview.batches.map((b) => b.dates[0]).sort()[0];
    setDone(`${preview.fo.name} joined ${campaignName} with ${people(r.enrolled)}. ${!first || first <= today ? "Their first steps are on today's list." : `Their first steps are due ${calendarDateLabel(first)}.`}`);
    setOpen(false); setChosen([]); reset(); router.refresh();
  });

  if (!candidates.length) return done ? <p role="status" className="text-sm text-emerald-700">{done}</p> : null;
  if (!open) return <section aria-label="Add an FO" className="flex flex-wrap items-center justify-end gap-3">
    {done && <p role="status" className="mr-auto text-sm text-emerald-700">{done}</p>}
    <span className="text-[12.5px] text-ink-500">Today only</span>
    <button type="button" className="btn-secondary" onClick={() => { setOpen(true); setDone(null); }}><IconPlus size={14} /> Add an FO</button>
  </section>;
  return <section className="surface p-5" aria-label="Add an FO">
    <div className="flex flex-wrap items-baseline gap-3"><h2 className="font-semibold">Add an FO</h2><span className="text-[12.5px] text-ink-500">Today only</span></div>
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm font-medium">FO<select aria-label="FO to add" className="mt-1 block !w-56" value={foId} onChange={(e) => { setFoId(e.target.value); setChosen([]); reset(); }}>{candidates.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label className="text-sm font-medium">New people a day<input aria-label="New FO new people per day" type="number" min={1} max={500} className="mt-1 block !w-24" value={pace || ''} onChange={(e) => { setPace(Number(e.target.value)); reset(); }} /></label>
      </div>
      <div><p className="mb-2 text-sm font-medium">{fo ? `${fo.name}'s people` : 'People'}</p><PeoplePicker key={foId} campaignPodId={podId} campaignFoIds={foId ? [foId] : []} value={chosen} onChange={(ids) => { setChosen(ids); reset(); }} /></div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {preview && <div role="status" className="rounded-lg border border-brand-200 bg-brand-50/60 p-4 text-sm">
        <p className="font-medium text-ink-900">{preview.fo.name} · {people(preview.people.length)} · {preview.pace} new a day{preview.pace !== preview.requested ? ` (asked ${preview.requested})` : ''}</p>
        <p className="mt-1 text-ink-700">Outreach: {preview.flow.name}{preview.flow.created ? ' (new, just for them)' : ''} · {steps(preview.flow.steps)}</p>
      </div>}
      {leftOut.length > 0 && <div className="text-sm"><p className="font-medium text-ink-900">{people(leftOut.length)} cannot join</p><ul className="mt-1 space-y-0.5 text-ink-600">{[...new Set(leftOut.map((l) => l.reason))].map((reason) => { const names = leftOut.filter((l) => l.reason === reason).map((l) => l.name); return <li key={reason}>{reason}: {names.slice(0, 6).join(', ')}{names.length > 6 ? ` and ${names.length - 6} more` : ''}</li>; })}</ul></div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => { setOpen(false); reset(); }}>Cancel</button>
        {preview ? <button type="button" className="btn-primary" disabled={pending} onClick={apply}>{pending ? 'Adding…' : `Add ${preview.fo.name} to this campaign`}</button>
          : <button type="button" className="btn-primary" disabled={pending || !chosen.length || !foId} onClick={plan}>{pending ? 'Planning…' : 'Preview'}</button>}
      </div>
    </div>
  </section>;
}
