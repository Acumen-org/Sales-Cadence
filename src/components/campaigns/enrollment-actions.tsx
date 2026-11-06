'use client';

import { useState } from 'react';
import { exitEnrollmentAction, pauseEnrollmentAction, reassignEnrollmentAction, resumeEnrollmentAction } from '@/lib/actions/enrollments';
import { ActionButton, ActionForm } from '@/components/action-form';
import { exitEnrollmentConfirm } from '@/lib/confirms';

type Props = {
  enrollmentId: string;
  status: string;
  foUserId: string;
  fos: { id: string; name: string }[];
  compact?: boolean;
  /** Who and which campaign, for the Exit confirm. */
  name?: string | null;
  campaign?: string | null;
};

/** Row actions for an enrollment: pause / resume / exit / reassign within pod. */
export function EnrollmentActions({ enrollmentId, status, foUserId, fos, compact, name, campaign }: Props) {
  const [reassigning, setReassigning] = useState(false);
  const open = status === 'ACTIVE' || status === 'PAUSED';
  if (!open) return <span className="text-xs text-ink-400">-</span>;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {status === 'ACTIVE' ? (
        <ActionButton action={pauseEnrollmentAction} payload={{ enrollmentId, reason: 'manual' }} className="btn-ghost btn-sm">
          Pause
        </ActionButton>
      ) : (
        <ActionButton action={resumeEnrollmentAction} payload={{ enrollmentId }} className="btn-ghost btn-sm">
          Resume
        </ActionButton>
      )}
      {fos.length > 1 ? (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setReassigning((v) => !v)}>
          Reassign
        </button>
      ) : null}
      <ActionButton action={exitEnrollmentAction} payload={{ enrollmentId, reason: 'manual' }} className="btn-ghost btn-sm text-red-600" confirm={exitEnrollmentConfirm({ name, campaign })}>
        Exit
      </ActionButton>
      {reassigning ? (
        <ActionForm action={reassignEnrollmentAction} className={compact ? 'w-full' : ''} onSuccess={() => setReassigning(false)}>
          <input type="hidden" name="enrollmentId" value={enrollmentId} />
          <div className="mt-1 flex items-center gap-1">
            <select name="foUserId" defaultValue={foUserId} className="text-xs">
              {fos.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary btn-sm">
              Move
            </button>
          </div>
        </ActionForm>
      ) : null}
    </div>
  );
}
