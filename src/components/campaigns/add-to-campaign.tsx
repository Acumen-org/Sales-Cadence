'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addPeopleToCampaignAction, campaignChoicesAction, removePeopleFromCampaignAction } from '@/lib/actions/campaigns';
import type { CampaignChoice } from '@/lib/campaign-membership';
import { Modal } from '@/components/modal';
import { IconCampaigns, IconClose, IconPlus } from '@/components/icons';
import { Badge, Count, EmptyState } from '@/components/ui';
import { campaignSelectionUrl } from '@/lib/campaign-selection';

type Choice = CampaignChoice & { placesLeft: number | null };

/**
 * "Add to campaign": the upcoming and running campaigns the reader may change, each with the
 * places it still has, and a new campaign at the end. Works for one person or a selection.
 */
export function AddToCampaign({ personIds, className = 'btn-primary btn-sm', label = 'Add to campaign', onDone, disabled = false, disabledTitle }: { personIds: string[]; className?: string; label?: string; onDone?: () => void; /** Greyed out, with the reason on hover: everyone chosen is already in a campaign. */ disabled?: boolean; disabledTitle?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    setChoices(null);
    setError(null);
    setMessage(null);
    void campaignChoicesAction().then((r) => { if (r.ok) setChoices(r.data as Choice[]); else setError(r.error); });
  }, [open]);

  const add = (campaignId: string) =>
    start(async () => {
      const choice = choices?.find(c => c.id === campaignId);
      if (choice?.calendar) { try { router.push(campaignSelectionUrl(`/campaigns/${campaignId}/edit`, personIds)); } catch { setError('Your browser could not retain this selection. Open the campaign and select people there.'); } return; }

      const fd = new FormData();
      fd.set('campaignId', campaignId);
      fd.set('personIds', JSON.stringify(personIds));
      const r = await addPeopleToCampaignAction(fd);
      if (r.ok) { setMessage(r.message ?? 'Done.'); router.refresh(); onDone?.(); }
      else setError(r.error);
    });

  return (
    <>
      <button type="button" className={className} disabled={disabled || !personIds.length} title={disabled ? disabledTitle : undefined} onClick={() => setOpen(true)}>
        <IconPlus size={13} /> {label}
      </button>
      {open ? (
        <Modal label="Add to campaign" onClose={() => setOpen(false)}>
          <div className="flex items-center gap-3 border-b border-line p-5">
            <h2 className="text-lg font-semibold">Add <Count value={personIds.length} /> {personIds.length === 1 ? 'person' : 'people'} to a campaign</h2>
            <button type="button" aria-label="Close" className="btn-icon-ghost ml-auto" onClick={() => setOpen(false)}><IconClose size={16} /></button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {error ? <p role="alert" className="p-5 text-sm text-red-700">{error}</p> : null}
            {message ? <p role="status" className="p-5 text-sm text-emerald-700">{message}</p> : null}
            {!choices && !error ? <p role="status" className="p-5 text-sm text-ink-500">Loading campaigns…</p> : null}
            {choices && !choices.length ? <EmptyState icon={<IconCampaigns size={20} />} title="No upcoming or active campaigns" /> : null}
            {choices?.length ? (
              <ul className="divide-y divide-line">
                {choices.map((c) => {
                  const full = c.placesLeft !== null && c.placesLeft < personIds.length;
                  return (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-medium text-ink-900">{c.name}</span>
                          <Badge tone={c.kind === 'upcoming' ? 'purple' : c.status === 'PAUSED' ? 'amber' : 'green'}>{c.kind === 'upcoming' ? (c.status === 'PENDING_APPROVAL' ? 'Awaiting approval' : 'Upcoming') : c.status === 'PAUSED' ? 'Paused' : 'Active'}</Badge>
                        </div>
                        <div className="mt-0.5 text-[12px] text-ink-500">{c.podName} · {c.startDate}{c.endDate ? ` → ${c.endDate}` : ''} · <Count value={c.members} /> in it{c.placesLeft !== null ? <> · <span className={full ? 'text-red-700' : ''}><Count value={c.placesLeft} /> places left</span></> : null}</div>
                      </div>
                      <button type="button" className="btn-secondary btn-sm" disabled={pending || full || (c.calendar && c.kind === 'running')} onClick={() => add(c.id)} title={full ? 'Not enough room before the end date' : c.calendar && c.kind === 'running' ? 'Active campaign plans are locked' : undefined}>
                        {c.calendar ? c.kind === 'running' ? 'Plan locked' : 'Add and review' : 'Add'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line p-4">
            <button type="button" onClick={() => { try { router.push(campaignSelectionUrl('/campaigns/new', personIds)); } catch { setError('Your browser could not retain this selection. Open a new campaign and select people there.'); } }} className="btn-primary btn-sm"><IconPlus size={13} /> New campaign</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>Close</button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/** "Remove from campaign", one or many, with the count in the confirmation. */
export function RemoveFromCampaign({ campaignId, campaignName, personIds, className = 'btn-danger btn-sm', label = 'Remove from campaign', onDone }: { campaignId: string; campaignName: string; personIds: string[]; className?: string; label?: string; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        className={className}
        disabled={pending || !personIds.length}
        onClick={() => {
          if (!window.confirm(`Remove ${personIds.length} ${personIds.length === 1 ? 'person' : 'people'} from ${campaignName}? Anyone mid-sequence stops there.`)) return;
          start(async () => {
            const fd = new FormData();
            fd.set('campaignId', campaignId);
            fd.set('personIds', JSON.stringify(personIds));
            const r = await removePeopleFromCampaignAction(fd);
            setMessage(r.ok ? { ok: true, text: r.message ?? 'Done.' } : { ok: false, text: r.error });
            if (r.ok) { router.refresh(); onDone?.(); }
          });
        }}
      >
        {label}
      </button>
      {message ? <span role="status" className={`mt-1 text-xs ${message.ok ? 'text-emerald-700' : 'text-red-700'}`}>{message.text}</span> : null}
    </span>
  );
}

/** Take a selection out of whichever campaigns hold them - one confirmation, one call per campaign. */
export function RemoveFromCampaigns({ people, className = 'btn-danger btn-sm', onDone }: { people: { id: string; campaignId: string; campaignName: string }[]; className?: string; onDone?: (message?: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const byCampaign = new Map<string, { name: string; ids: string[] }>();
  for (const p of people) { const g = byCampaign.get(p.campaignId) ?? { name: p.campaignName, ids: [] }; g.ids.push(p.id); byCampaign.set(p.campaignId, g); }
  const names = [...byCampaign.values()].map((g) => g.name);
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        className={className}
        disabled={pending || !people.length}
        onClick={() => {
          if (!window.confirm(`Remove ${people.length} ${people.length === 1 ? 'person' : 'people'} from ${names.length === 1 ? names[0] : `${names.length} campaigns`}? Anyone mid-sequence stops there.`)) return;
          start(async () => {
            const results: string[] = [];
            let failed = false;
            for (const [campaignId, g] of byCampaign) {
              const fd = new FormData();
              fd.set('campaignId', campaignId);
              fd.set('personIds', JSON.stringify(g.ids));
              const r = await removePeopleFromCampaignAction(fd);
              if (r.ok) results.push(r.message ?? 'Done.'); else { failed = true; results.push(r.error); }
            }
            setMessage({ ok: !failed, text: results.join(' ') });
            if (!failed) { router.refresh(); onDone?.(results.join(' ')); }
          });
        }}
      >
        Remove from campaign{names.length > 1 ? 's' : ''}
      </button>
      {message ? <span role="status" className={`mt-1 text-xs ${message.ok ? 'text-emerald-700' : 'text-red-700'}`}>{message.text}</span> : null}
    </span>
  );
}
