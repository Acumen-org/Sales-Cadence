'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACTION_LABELS, ACTION_TYPES, newStepId, StepsSchema, type ActionType, type SequenceStep, type StepAction } from '@/lib/sequences/steps';
import { TEMPLATE_VARIABLES } from '@/lib/templates';
import { ActionForm } from '@/components/action-form';
import type { ActionResult } from '@/lib/actions/users';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@/components/icons';
import { Field } from '@/components/ui';

type Props = {
  sequenceId?: string;
  initialSteps: SequenceStep[];
  action: (formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
  /** Extra fields rendered above the steps (name/description for a new sequence). */
  header?: React.ReactNode;
  askChangeNote?: boolean;
};

function blankAction(type: ActionType = 'EMAIL'): StepAction {
  return { id: newStepId('act'), type, label: ACTION_LABELS[type], template: '' };
}

/**
 * Add/remove/reorder steps, edit day offsets, actions, either/or alternatives and templates.
 * Step and action ids are preserved so enrollments can be mapped into the new version.
 */
export function SequenceEditor({ sequenceId, initialSteps, action, submitLabel, header, askChangeNote }: Props) {
  const router = useRouter();
  const [steps, setSteps] = useState<SequenceStep[]>(() => JSON.parse(JSON.stringify(initialSteps)));
  const validation = useMemo(() => {
    const r = StepsSchema.safeParse(steps);
    return r.success ? null : r.error.issues.map((i) => `Step ${Number(i.path[0]) + 1}: ${i.message}`).join(' · ');
  }, [steps]);

  const update = (i: number, patch: Partial<SequenceStep>) => setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  const updateAction = (i: number, j: number, patch: Partial<StepAction>) =>
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, actions: st.actions.map((a, k) => (k === j ? { ...a, ...patch } : a)) } : st)));
  const move = (i: number, dir: -1 | 1) =>
    setSteps((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      const [a, b] = [copy[i], copy[j]];
      // swap positions but keep the day offsets in ascending order
      copy[i] = { ...b, day: a.day };
      copy[j] = { ...a, day: b.day };
      return copy;
    });
  const addStep = () =>
    setSteps((s) => {
      const lastDay = s.length ? s[s.length - 1].day : 0;
      return [...s, { id: newStepId('step'), day: lastDay + 3, title: '', actions: [blankAction()] }];
    });

  return (
    <ActionForm
      action={action}
      onSuccess={(r) => {
        if (r.redirectTo) router.push(r.redirectTo);
        router.refresh();
      }}
      className="space-y-4"
    >
      {sequenceId ? <input type="hidden" name="sequenceId" value={sequenceId} /> : null}
      <input type="hidden" name="steps" value={JSON.stringify(steps)} />
      {header}

      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={step.id} className="card p-4">
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-white">{i + 1}</div>
              <Field label="Day" className="w-24">
                <input type="number" min={1} value={step.day} onChange={(e) => update(i, { day: Number(e.target.value) })} className="w-full" />
              </Field>
              <Field label="Step title (optional)" className="min-w-[200px] flex-1">
                <input value={step.title ?? ''} onChange={(e) => update(i, { title: e.target.value })} className="w-full" placeholder="e.g. First call" />
              </Field>
              <div className="ml-auto flex items-center gap-1">
                <button type="button" className="btn-ghost btn-sm" onClick={() => move(i, -1)} disabled={i === 0} title="Move up">
                  <IconArrowUp size={14} />
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => move(i, 1)} disabled={i === steps.length - 1} title="Move down">
                  <IconArrowDown size={14} />
                </button>
                <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => setSteps((s) => s.filter((_, idx) => idx !== i))} disabled={steps.length === 1} title="Remove step">
                  <IconTrash size={14} />
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {step.actions.map((a, j) => (
                <div key={a.id} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="grid gap-3 md:grid-cols-[160px_1fr_auto]">
                    <Field label={j === 0 ? 'Action' : `Then`}>
                      <select value={a.type} onChange={(e) => updateAction(i, j, { type: e.target.value as ActionType, label: a.label === ACTION_LABELS[a.type] ? ACTION_LABELS[e.target.value as ActionType] : a.label })} className="w-full">
                        {ACTION_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {ACTION_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Label" hint="Shown to FOs and in the Twenty note, e.g. Email 2">
                      <input value={a.label} onChange={(e) => updateAction(i, j, { label: e.target.value })} className="w-full" />
                    </Field>
                    <div className="flex items-end gap-1">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() =>
                          updateAction(i, j, {
                            alternative: a.alternative ? undefined : { type: a.type === 'EMAIL' ? 'LINKEDIN_MESSAGE' : 'EMAIL', label: a.type === 'EMAIL' ? 'LinkedIn message' : 'Follow-up email', template: '' },
                          })
                        }
                      >
                        {a.alternative ? 'Remove either/or' : 'Add either/or'}
                      </button>
                      <button type="button" className="btn-ghost btn-sm text-red-600" disabled={step.actions.length === 1} onClick={() => update(i, { actions: step.actions.filter((_, k) => k !== j) })} title="Remove action">
                        <IconTrash size={14} />
                      </button>
                    </div>
                  </div>
                  {a.type === 'EMAIL' ? (
                    <Field label="Subject" className="mt-2">
                      <input value={a.subject ?? ''} onChange={(e) => updateAction(i, j, { subject: e.target.value })} className="w-full" />
                    </Field>
                  ) : null}
                  <Field label={a.type === 'CALL' ? 'Call script' : a.variants?.length ? 'Template (fallback when every variant is disabled)' : 'Template'} className="mt-2">
                    <textarea rows={4} value={a.template ?? ''} onChange={(e) => updateAction(i, j, { template: e.target.value })} className="w-full font-mono text-xs" />
                  </Field>
                  {a.type === 'EMAIL' ? (
                    <div className="mt-2 space-y-2">
                      <label className="inline-flex items-center gap-1.5 text-sm font-normal text-slate-700">
                        <input type="checkbox" checked={Boolean(a.replyInThread)} onChange={(e) => updateAction(i, j, { replyInThread: e.target.checked || undefined })} className="h-4 w-4 rounded" />
                        Send as a reply in the existing thread
                      </label>
                      {(a.variants ?? []).map((v, k) => (
                        <div key={v.id} className={`rounded-md border p-3 ${v.enabled === false ? 'border-slate-200 bg-slate-100 opacity-70' : 'border-violet-200 bg-violet-50/40'}`}>
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-violet-700">A/B variant</span>
                            <input value={v.label} onChange={(e) => updateAction(i, j, { variants: a.variants!.map((x, idx) => (idx === k ? { ...x, label: e.target.value } : x)) })} className="w-32 py-1 text-xs" />
                            <label className="inline-flex items-center gap-1 text-xs font-normal text-slate-700">
                              <input type="checkbox" checked={v.enabled !== false} onChange={(e) => updateAction(i, j, { variants: a.variants!.map((x, idx) => (idx === k ? { ...x, enabled: e.target.checked } : x)) })} className="h-3.5 w-3.5 rounded" /> enabled
                            </label>
                            <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => updateAction(i, j, { variants: a.variants!.filter((_, idx) => idx !== k).length ? a.variants!.filter((_, idx) => idx !== k) : undefined })}>
                              <IconTrash size={12} />
                            </button>
                          </div>
                          <Field label="Subject">
                            <input value={v.subject ?? ''} onChange={(e) => updateAction(i, j, { variants: a.variants!.map((x, idx) => (idx === k ? { ...x, subject: e.target.value } : x)) })} className="w-full" />
                          </Field>
                          <Field label="Template" className="mt-2">
                            <textarea rows={3} value={v.template ?? ''} onChange={(e) => updateAction(i, j, { variants: a.variants!.map((x, idx) => (idx === k ? { ...x, template: e.target.value } : x)) })} className="w-full font-mono text-xs" />
                          </Field>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          const n = (a.variants?.length ?? 0) + 1;
                          const label = String.fromCharCode(64 + n);
                          const existing = a.variants ?? [];
                          // The first variant starts as a copy of the current template so A vs B is a fair test.
                          const seed = existing.length ? [] : [{ id: newStepId('act'), label: 'A', subject: a.subject, template: a.template, enabled: true }];
                          updateAction(i, j, { variants: [...existing, ...seed, { id: newStepId('act'), label: seed.length ? 'B' : label, subject: a.subject, template: a.template, enabled: true }] });
                        }}
                      >
                        <IconPlus size={12} /> {a.variants?.length ? 'Add another variant' : 'Add A/B test'}
                      </button>
                    </div>
                  ) : null}
                  {a.alternative ? (
                    <div className="mt-3 rounded-md border border-dashed border-slate-300 bg-white p-3">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Or instead</div>
                      <div className="grid gap-3 md:grid-cols-[160px_1fr]">
                        <Field label="Action">
                          <select value={a.alternative.type} onChange={(e) => updateAction(i, j, { alternative: { ...a.alternative!, type: e.target.value as ActionType } })} className="w-full">
                            {ACTION_TYPES.filter((t) => t !== a.type).map((t) => (
                              <option key={t} value={t}>
                                {ACTION_LABELS[t]}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Label">
                          <input value={a.alternative.label} onChange={(e) => updateAction(i, j, { alternative: { ...a.alternative!, label: e.target.value } })} className="w-full" />
                        </Field>
                      </div>
                      {a.alternative.type === 'EMAIL' ? (
                        <Field label="Subject" className="mt-2">
                          <input value={a.alternative.subject ?? ''} onChange={(e) => updateAction(i, j, { alternative: { ...a.alternative!, subject: e.target.value } })} className="w-full" />
                        </Field>
                      ) : null}
                      <Field label="Template" className="mt-2">
                        <textarea rows={3} value={a.alternative.template ?? ''} onChange={(e) => updateAction(i, j, { alternative: { ...a.alternative!, template: e.target.value } })} className="w-full font-mono text-xs" />
                      </Field>
                    </div>
                  ) : null}
                </div>
              ))}
              <button type="button" className="btn-secondary btn-sm" onClick={() => update(i, { actions: [...step.actions, blankAction('CALL')] })}>
                <IconPlus size={14} /> Add action to this step
              </button>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary" onClick={addStep}>
          <IconPlus size={16} /> Add step
        </button>
        <span className="text-xs text-slate-500">Variables: {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(' ')}</span>
      </div>

      {askChangeNote ? (
        <Field label="What changed? (kept in version history)">
          <input name="changeNote" className="w-full" placeholder="e.g. Softer Email 2, moved call to day 4" />
        </Field>
      ) : null}
      {validation ? <p className="text-sm text-red-700">{validation}</p> : null}
      <button type="submit" className="btn-primary" disabled={Boolean(validation)}>
        {submitLabel}
      </button>
    </ActionForm>
  );
}
