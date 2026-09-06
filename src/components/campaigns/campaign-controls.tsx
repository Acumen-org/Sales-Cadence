'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { pauseCampaignAction, reenrollNonRepliersAction, resumeCampaignAction, stopCampaignAction } from '@/lib/actions/campaigns';
import { ActionButton, ActionForm } from '@/components/action-form';
import { Card, Field } from '@/components/ui';

type Props = {
  campaignId: string;
  status: string;
  sequences: { id: string; name: string }[];
  currentSequenceId: string;
  defaultName: string;
  today: string;
};

export function CampaignControls({ campaignId, status, sequences, currentSequenceId, defaultName, today }: Props) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const running = status === 'ACTIVE' || status === 'PAUSED';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {status === 'ACTIVE' ? (
          <ActionButton action={pauseCampaignAction} payload={{ campaignId }} className="btn-secondary" confirm="Pause every active enrollment in this campaign?">
            Pause campaign
          </ActionButton>
        ) : null}
        {status === 'PAUSED' ? (
          <ActionButton action={resumeCampaignAction} payload={{ campaignId }} className="btn-secondary">
            Resume campaign
          </ActionButton>
        ) : null}
        {running ? (
          <ActionButton action={stopCampaignAction} payload={{ campaignId }} className="btn-danger" confirm="Stop the campaign and exit everyone still in it? This cannot be undone.">
            Stop campaign
          </ActionButton>
        ) : null}
      </div>
      <Card title="Re-enrol non-repliers into another sequence">
        <ActionForm
          action={reenrollNonRepliersAction}
          className="grid gap-3 p-4 md:grid-cols-4"
          onSuccess={(r) => {
            if (r.redirectTo) router.push(r.redirectTo);
            else if (r.data) setConfirm(true);
          }}
        >
          <input type="hidden" name="campaignId" value={campaignId} />
          <input type="hidden" name="confirm" value={confirm ? 'yes' : 'no'} />
          <Field label="Into sequence">
            <select name="sequenceId" className="w-full" defaultValue={sequences.find((s) => s.id !== currentSequenceId)?.id ?? currentSequenceId}>
              {sequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Days after finishing">
            <input name="days" type="number" min={0} defaultValue={14} className="w-full" />
          </Field>
          <Field label="New campaign name">
            <input name="name" defaultValue={defaultName} className="w-full" />
          </Field>
          <Field label="Start">
            <input name="startDate" type="date" defaultValue={today} className="w-full" />
          </Field>
          <div className="md:col-span-4">
            <button type="submit" className={confirm ? 'btn-primary' : 'btn-secondary'}>
              {confirm ? 'Confirm and create follow-up campaign' : 'Check who qualifies'}
            </button>
            {confirm ? (
              <button type="button" className="btn-ghost ml-2" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
