'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createCampaignAction, previewCampaignAction, type CampaignPreview } from '@/lib/actions/campaigns';
import type { ActionResult } from '@/lib/actions/users';
import { Badge, Card, Field, Notice } from '@/components/ui';

type Props = {
  sequences: { id: string; name: string }[];
  pods: { id: string; name: string; podOwnerValue: string }[];
  defaultStartDate: string;
  defaultRamp: number;
  mockViews?: { id: string; name: string }[];
  /** Pre-filled person ids (from a bulk selection on People), one per line. */
  initialIds?: string;
};

const CONFLICT_LABEL: Record<string, string> = {
  dnd: 'Do not contact',
  already_active: 'Already in a sequence',
  not_found: 'Not found in Twenty',
  deleted: 'Deleted in Twenty',
  duplicate: 'Duplicate id',
  no_fo: 'No FO in pod',
  invalid_start: 'Invalid start date',
  opted_out: 'Asked not to be contacted',
  bad_data: 'Contact details are not usable',
};

/** Create a campaign: choose people (ids, CSV or Twenty view), preview conflicts, confirm. */
export function CampaignForm({ sequences, pods, defaultStartDate, defaultRamp, mockViews, initialIds }: Props) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [sourceType, setSourceType] = useState<'IDS' | 'CSV' | 'TWENTY_VIEW'>('IDS');
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  const collect = () => {
    const fd = new FormData(formRef.current!);
    fd.set('sourceType', sourceType);
    if (sourceType === 'CSV') fd.set('personIdsText', csvText);
    return fd;
  };

  const runPreview = () =>
    start(async () => {
      setResult(null);
      const r = await previewCampaignAction(collect());
      if (r.ok) setPreview(r.data as CampaignPreview);
      else {
        setPreview(null);
        setResult(r);
      }
    });

  const create = () =>
    start(async () => {
      const r = await createCampaignAction(collect());
      setResult(r);
      if (r.ok && r.redirectTo) router.push(r.redirectTo);
    });

  return (
    <form ref={formRef} onSubmit={(e) => e.preventDefault()} className="space-y-6">
      <Card title="1. Campaign">
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <Field label="Name">
            <input name="name" required className="w-full" placeholder="Campaign name" />
          </Field>
          <Field label="Sequence">
            <select name="sequenceId" required className="w-full">
              {sequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pod" info="Reports roll up by pod. FOs are chosen from the pod's members.">
            <select name="podId" required className="w-full">
              {pods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.podOwnerValue})
                </option>
              ))}
            </select>
          </Field>
          <Field label="FO assignment">
            <select name="assignmentMode" className="w-full" defaultValue="OWNER">
              <option value="OWNER">Person owner in Twenty, else least-loaded FO in pod</option>
              <option value="ROUND_ROBIN">Round robin within pod (least loaded)</option>
            </select>
          </Field>
          <Field label="Start date" info="Weekends roll to the next working day.">
            <input name="startDate" type="date" required defaultValue={defaultStartDate} />
          </Field>
          <Field label="Daily ramp per FO" info="New people started per FO per working day. Blank = all at once.">
            <input name="dailyRampPerFo" type="number" min={0} defaultValue={defaultRamp} className="w-32" />
          </Field>
          <Field label="Notes (optional)" className="md:col-span-2">
            <input name="notes" className="w-full" />
          </Field>
        </div>
      </Card>

      <Card title="2. People">
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            {(['IDS', 'CSV', 'TWENTY_VIEW'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setSourceType(t);
                  setPreview(null);
                }}
                className={sourceType === t ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              >
                {t === 'IDS' ? 'Paste person ids' : t === 'CSV' ? 'Upload CSV' : 'Twenty view'}
              </button>
            ))}
          </div>
          {sourceType === 'IDS' ? (
            <Field label="Twenty person ids" info="One per line, or comma separated. Copy them from Twenty's URL bar or an export.">
              <textarea name="personIdsText" rows={8} className="w-full font-mono text-xs" placeholder={'3f6c1c5e-...\n8a1b2c3d-...'} defaultValue={initialIds ?? ''} />
            </Field>
          ) : null}
          {sourceType === 'CSV' ? (
            <Field label="CSV export from Twenty" info="Uses the column named id / personId (or the first column). Parsed in your browser, only the ids are sent.">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  setCsvText(f ? await f.text() : '');
                  setPreview(null);
                }}
              />
              {csvText ? <p className="mt-1 text-xs text-ink-600"><span className="font-medium text-ink-900">{csvText.split(/\r?\n/).filter(Boolean).length}</span> lines loaded</p> : null}
            </Field>
          ) : null}
          {sourceType === 'TWENTY_VIEW' ? (
            <Field label="Saved Twenty view id" info="From the view's URL in Twenty (Settings > Views also lists them). Simple filters are supported.">
              {mockViews?.length ? (
                <select name="viewId" className="w-full">
                  {mockViews.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.id})
                    </option>
                  ))}
                </select>
              ) : (
                <input name="viewId" className="w-full" placeholder="view id" />
              )}
            </Field>
          ) : null}
          <div className="flex items-center gap-3">
            <button type="button" className="btn-secondary" onClick={runPreview} disabled={pending}>
              {pending ? 'Checking...' : 'Preview conflicts'}
            </button>
          </div>
        </div>
      </Card>

      {preview ? (
        <Card title={`3. Review: ${preview.candidates.length} will be enrolled, ${preview.conflicts.length} skipped`}>
          <div className="space-y-4 p-4">
            {preview.note ? <Notice tone="info">{preview.note}</Notice> : null}
            {preview.warnings.map((w) => (
              <Notice key={w} tone="warn">
                {w}
              </Notice>
            ))}
            {preview.conflicts.length ? (
              <div>
                <h4 className="mb-1 text-sm font-semibold text-ink-800">Skipped</h4>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Reason</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.conflicts.map((c) => (
                      <tr key={`${c.personId}-${c.reason}`}>
                        <td>
                          {c.name}
                          <div className="font-mono text-[11px] text-ink-600">{c.personId}</div>
                        </td>
                        <td>
                          <Badge tone={c.reason === 'dnd' ? 'red' : 'amber'}>{CONFLICT_LABEL[c.reason] ?? c.reason}</Badge>
                        </td>
                        <td className="text-xs">{c.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {preview.candidates.length ? (
              <div className="max-h-80 overflow-y-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Company</th>
                      <th>FO</th>
                      <th>Starts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.candidates.map((c) => (
                      <tr key={c.personId}>
                        <td>
                          {c.name}
                          {c.podMismatch ? <Badge tone="amber" className="ml-1">other pod</Badge> : null}
                        </td>
                        <td>{c.companyName}</td>
                        <td>
                          {c.foName} <span className="text-xs text-ink-400">({c.assignedBy.replace('_', ' ')})</span>
                        </td>
                        <td>{c.startDate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Notice tone="warn">Nobody can be enrolled with these settings.</Notice>
            )}
            <button type="button" className="btn-primary" onClick={create} disabled={pending || preview.candidates.length === 0}>
              {pending ? 'Creating...' : `Create campaign and enrol ${preview.candidates.length}`}
            </button>
          </div>
        </Card>
      ) : null}

      {result ? <Notice tone={result.ok ? 'success' : 'error'}>{result.ok ? result.message : result.error}</Notice> : null}
    </form>
  );
}
