'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Modal } from '@/components/modal';
import { preflightMoveAction, queueMoveAction } from '@/lib/actions/sandbox-move';
import type { PreflightItem } from '@/lib/sandbox/move';

const STATE_LABEL: Record<PreflightItem['state'], string> = { ready: 'Ready', needs: 'Needs', attach: 'Already in Twenty', refused: 'Cannot move' };

/**
 * Move to CRM (plan 8.6): each contact says whether it is ready, what it needs, whether Twenty
 * already has the person (its history is attached to them instead), and which firm it lands on.
 * Contacts that are not ready are left out, grouped by reason.
 */
export function MoveDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [items, setItems] = useState<PreflightItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    void preflightMoveAction(ids).then((r) => { if (!alive) return; if (r.ok) setItems(r.items); else setError(r.error); });
    return () => { alive = false; };
  }, [ids]);
  const movable = (items ?? []).filter((i) => i.state === 'attach' || (i.state === 'ready' && (i.firm.action !== 'choose' || chosen[i.contactId])));
  const left = (items ?? []).filter((i) => !movable.includes(i));
  const reasons = new Map<string, string[]>();
  for (const i of left) { const why = i.state === 'needs' ? `Needs ${i.missing.map((m) => m.text.toLowerCase()).join(', ')}` : i.firm.action === 'choose' ? 'Choose the firm' : i.reason ?? 'Cannot move'; reasons.set(why, [...(reasons.get(why) ?? []), i.name]); }
  return <Modal label="Move to CRM" onClose={onClose} className="max-w-2xl">
    <div className="space-y-4 p-5">
      <h2 className="text-base font-semibold text-ink-900">Move to CRM</h2>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {!items && !error ? <p role="status" className="text-sm text-ink-500">Checking each contact against Twenty…</p> : null}
      {items ? <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">{items.map((i) => <li key={i.contactId} className="flex items-start gap-3 px-3 py-2.5 text-[13px]">
        <span className="min-w-0 flex-1"><span className="block text-ink-900">{i.name}</span>
          <span className="block text-ink-500">{i.state === 'attach' ? `History goes to ${i.crmPerson?.name}, who is in Twenty already` : i.state === 'needs' ? i.missing.map((m) => m.text).join(', ') : i.state === 'refused' ? i.reason : i.firm.action === 'link' ? `Links to ${i.firm.name}` : i.firm.action === 'create' ? `Creates ${i.firm.name}` : i.firm.action === 'choose' ? 'Several firms match' : 'No firm'}</span>
          {i.state === 'ready' && i.firm.action === 'choose' ? <select aria-label={`Firm for ${i.name}`} className="mt-1 !py-1" value={chosen[i.contactId] ?? ''} onChange={(e) => setChosen({ ...chosen, [i.contactId]: e.target.value })}><option value="" disabled>Choose the firm in Twenty</option>{i.firm.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.domain ? ` (${c.domain})` : ''}</option>)}</select> : null}
        </span>
        <span className={clsx('shrink-0 rounded-md px-2 py-0.5 text-[12px]', i.state === 'ready' ? 'bg-brand-50 text-brand-800' : i.state === 'attach' ? 'bg-sky-50 text-sky-800' : 'bg-canvas text-ink-600')}>{STATE_LABEL[i.state]}</span>
      </li>)}</ul> : null}
      {left.length && items ? <div className="text-[13px] text-ink-600">{[...reasons.entries()].map(([why, names]) => <div key={why}>Left out: {names.join(', ')} ({why.toLowerCase()})</div>)}</div> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!movable.length || pending} onClick={() => start(async () => {
          const r = await queueMoveAction(movable.map((i) => ({ contactId: i.contactId, mode: i.state === 'attach' ? 'attach' : 'create', attachPersonId: i.crmPerson?.id ?? null, companyId: chosen[i.contactId] ?? null })));
          if (!r.ok) { setError(r.error); return; }
          onClose();
          if (r.redirectTo) router.push(r.redirectTo); else router.refresh();
        })}>{pending ? 'Moving' : `Move ${movable.length}`}</button>
      </div>
    </div>
  </Modal>;
}
