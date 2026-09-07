'use client';

import { useState } from 'react';
import { clearBadDataAction, finishEnrollmentAction, moveEnrollmentToStepAction, setOptOutAction } from '@/lib/actions/people';
import { exitEnrollmentAction, pauseEnrollmentAction, reassignEnrollmentAction, resumeEnrollmentAction } from '@/lib/actions/enrollments';
import { ActionButton, ActionForm } from '@/components/action-form';
import { PersonRowActions } from './person-row-actions';

type Props = {
  personId: string;
  optedOut: boolean;
  badEmail: boolean;
  badPhone: boolean;
  dnd: boolean;
  canManagePerson: boolean;
  active: { id: string; status: string; foUserId: string; currentStep: number; canManage: boolean } | null;
  steps: { index: number; label: string }[];
  fos: { id: string; name: string }[];
  sequences: { id: string; name: string }[];
  pods: { id: string; name: string; podOwnerValue: string; fos: { id: string; name: string }[] }[];
  defaultPodId: string | null;
};

/** Outreach-style prospect controls: sequence actions, opt-out, bad-data flags. */
export function PersonControls(p: Props) {
  const [moveTo, setMoveTo] = useState(p.steps.find((s) => s.index > (p.active?.currentStep ?? -1))?.index ?? 0);
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Sequence</h3>
        {p.active ? (
          <div className="flex flex-wrap items-center gap-2">
            {p.active.status === 'ACTIVE' ? (
              <ActionButton action={pauseEnrollmentAction} payload={{ enrollmentId: p.active.id, reason: 'manual' }} className="btn-secondary btn-sm">
                Pause
              </ActionButton>
            ) : (
              <ActionButton action={resumeEnrollmentAction} payload={{ enrollmentId: p.active.id }} className="btn-secondary btn-sm">
                Resume
              </ActionButton>
            )}
            <ActionButton action={finishEnrollmentAction} payload={{ enrollmentId: p.active.id, kind: 'replied' }} className="btn-secondary btn-sm" confirm="Mark as replied and finish the sequence?">
              Finish (Replied)
            </ActionButton>
            <ActionButton action={finishEnrollmentAction} payload={{ enrollmentId: p.active.id, kind: 'no_reply' }} className="btn-secondary btn-sm" confirm="Finish the sequence with no reply?">
              Finish (No reply)
            </ActionButton>
            {p.active.canManage && p.steps.some((s) => s.index > p.active!.currentStep) ? (
              <ActionForm action={moveEnrollmentToStepAction} className="inline-flex items-center gap-1">
                <input type="hidden" name="enrollmentId" value={p.active.id} />
                <select name="stepIndex" value={moveTo} onChange={(e) => setMoveTo(Number(e.target.value))} className="py-1 text-xs">
                  {p.steps
                    .filter((s) => s.index > p.active!.currentStep)
                    .map((s) => (
                      <option key={s.index} value={s.index}>
                        Step {s.index + 1}: {s.label}
                      </option>
                    ))}
                </select>
                <button type="submit" className="btn-secondary btn-sm">
                  Move to step
                </button>
              </ActionForm>
            ) : null}
            {p.active.canManage && p.fos.length > 1 ? (
              <ActionForm action={reassignEnrollmentAction} className="inline-flex items-center gap-1">
                <input type="hidden" name="enrollmentId" value={p.active.id} />
                <select name="foUserId" defaultValue={p.active.foUserId} className="py-1 text-xs">
                  {p.fos.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn-secondary btn-sm">
                  Reassign
                </button>
              </ActionForm>
            ) : null}
            {p.active.canManage ? (
              <ActionButton action={exitEnrollmentAction} payload={{ enrollmentId: p.active.id, reason: 'removed' }} className="btn-ghost btn-sm text-red-600" confirm="Remove from the sequence? Open tasks will be cancelled.">
                Remove
              </ActionButton>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-ink-600">Not in a sequence.</span>
            <PersonRowActions personId={p.personId} activeEnrollmentId={null} dnd={p.dnd || p.optedOut} canEnroll={p.canManagePerson} canExit={false} sequences={p.sequences} pods={p.pods} defaultPodId={p.defaultPodId} />
          </div>
        )}
      </div>

      {p.canManagePerson ? (
        <div className="card p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Contact preferences (Cadence only)</h3>
          <div className="flex flex-wrap items-center gap-2">
            {p.optedOut ? (
              <ActionButton action={setOptOutAction} payload={{ personId: p.personId, optedOut: 'false' }} className="btn-secondary btn-sm">
                Clear opt-out
              </ActionButton>
            ) : (
              <ActionButton action={setOptOutAction} payload={{ personId: p.personId, optedOut: 'true' }} className="btn-secondary btn-sm" confirm="Mark as opted out? Any live sequence ends and the person cannot be enrolled again.">
                Mark opted out
              </ActionButton>
            )}
            {p.badEmail || p.badPhone ? (
              <ActionButton action={clearBadDataAction} payload={{ personId: p.personId }} className="btn-secondary btn-sm">
                Clear bad-data flags
              </ActionButton>
            ) : null}
            <span className="text-xs text-ink-500">Twenty stays the record: set dnd there too if it should apply everywhere.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
