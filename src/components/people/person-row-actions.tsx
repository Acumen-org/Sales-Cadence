'use client';

import { useState } from 'react';
import { enrollOneAction, exitEnrollmentAction } from '@/lib/actions/enrollments';
import { ActionButton, ActionForm } from '@/components/action-form';

type Props = {
  personId: string;
  activeEnrollmentId: string | null;
  dnd: boolean;
  canEnroll: boolean;
  canExit: boolean;
  sequences: { id: string; name: string }[];
  pods: { id: string; name: string; podOwnerValue: string; fos: { id: string; name: string }[] }[];
  defaultPodId: string | null;
};

export function PersonRowActions({ personId, activeEnrollmentId, dnd, canEnroll, canExit, sequences, pods, defaultPodId }: Props) {
  const [open, setOpen] = useState(false);
  const [podId, setPodId] = useState(defaultPodId ?? pods[0]?.id ?? '');
  const pod = pods.find((p) => p.id === podId);

  if (activeEnrollmentId) {
    return canExit ? (
      <ActionButton action={exitEnrollmentAction} payload={{ enrollmentId: activeEnrollmentId, reason: 'manual' }} className="btn-ghost btn-sm text-red-600" confirm="Exit this person from their sequence?">
        Exit
      </ActionButton>
    ) : (
      <span className="text-xs text-ink-400">-</span>
    );
  }
  if (dnd || !canEnroll || !sequences.length || !pods.length) return <span className="text-xs text-ink-400">-</span>;

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen((v) => !v)}>
        {open ? 'Cancel' : 'Enrol'}
      </button>
      {open ? (
        <ActionForm action={enrollOneAction} className="w-72 space-y-2 rounded-md border border-line bg-white p-3 text-left shadow-md" onSuccess={() => setOpen(false)}>
          <input type="hidden" name="personId" value={personId} />
          <label className="block">Sequence</label>
          <select name="sequenceId" className="w-full text-xs">
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <label className="block">Pod</label>
          <select name="podId" value={podId} onChange={(e) => setPodId(e.target.value)} className="w-full text-xs">
            {pods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label className="block">FO</label>
          <select name="foUserId" className="w-full text-xs" defaultValue="">
            <option value="">Auto (Twenty owner, else least loaded)</option>
            {pod?.fos.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <label className="block">Start</label>
          <input name="startDate" type="date" className="w-full text-xs" />
          <button type="submit" className="btn-primary btn-sm w-full">
            Enrol now
          </button>
        </ActionForm>
      ) : null}
    </div>
  );
}
