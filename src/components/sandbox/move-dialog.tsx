'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Modal } from '@/components/modal';
import { Badge, Notice } from '@/components/ui';
import { preflightMoveAction, queueMoveAction } from '@/lib/actions/sandbox-move';
import { assignContactsAction, setPodAction } from '@/lib/actions/sandbox';
import type { MoveCounts, MoveGroup, MoveNextStep, MoveSelection, PreflightItem } from '@/lib/sandbox/move';

type Option = { id: string; name: string };
type Props = {
  ids: string[];
  onClose: () => void;
  /** Who the reader may give a contact to, for the "needs a new owner" fix (N017, B119). */
  owners?: (Option & { podIds: string[] })[];
  /** Pods the reader may put a contact in, for the "needs a pod" fix (B050). */
  pods?: Option[];
  /** The contact page's path, for fixes that need it. */
  contactHref?: (id: string) => string;
};

const GROUP_TITLE: Record<MoveGroup, string> = { needs: 'Needs info', in_crm: 'Already in CRM', ready: 'Ready to move', no_conversation: 'No conversation yet', left_out: 'Left out' };
const ORDER: MoveGroup[] = ['needs', 'in_crm', 'ready', 'no_conversation', 'left_out'];

/** "12 ready · 2 need info · 1 already in CRM · 3 no conversation yet · 2 left out" (B110). */
function countLine(c: MoveCounts): string {
  return [
    c.ready ? `${c.ready} ready` : null, c.needs ? `${c.needs} need${c.needs === 1 ? 's' : ''} info` : null, c.in_crm ? `${c.in_crm} already in CRM` : null,
    c.no_conversation ? `${c.no_conversation} no conversation yet` : null, c.left_out ? `${c.left_out} left out` : null,
  ].filter(Boolean).join(' · ') || 'Nothing to move';
}

/**
 * Move to CRM (4.5). A count line, then each contact in its group with one line per thing the move
 * will do (B110, B111): needs info with its fix in place (an owner who left, a pod: N017, B050), the
 * person already in the CRM with their card (B107) and "Not the same person: create new", a shared
 * office line that attaches only when ticked (B006), ready, no conversation yet (unticked, one
 * confirm: D3), and left out with the reason. Each contact keeps its own next step; those without
 * one get the step given here (B034). The body scrolls and the buttons stay in view at 1280x800
 * (B035); a disabled Move says why (B110). Nothing on any contact changes until its move succeeds.
 */
export function MoveDialog({ ids, onClose, owners = [], pods = [], contactHref = (id) => `/sandbox/${id}` }: Props) {
  const [items, setItems] = useState<PreflightItem[] | null>(null);
  const [counts, setCounts] = useState<MoveCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [firm, setFirm] = useState<Record<string, string>>({});
  const [createNew, setCreateNew] = useState<Set<string>>(new Set());
  const [attachShared, setAttachShared] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [step, setStep] = useState<MoveNextStep>({ label: '', action: 'CALL', dueDate: '' });
  const [fixing, setFixing] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const load = useCallback(async (keepPicks: boolean) => {
    const r = await preflightMoveAction(ids);
    if (!r.ok) { setError(r.error); setItems([]); return; }
    setItems(r.items); setCounts(r.counts); setToday(r.today);
    setStep((s) => (s.dueDate ? s : { ...s, dueDate: r.today }));
    // Ready and already-in-CRM contacts start ticked; "No conversation yet" never does (D3).
    setPicked((prev) => new Set(r.items.filter((i) => (i.group === 'ready' || i.group === 'in_crm') || (keepPicks && prev.has(i.contactId) && i.group === 'no_conversation')).map((i) => i.contactId)));
  }, [ids]);
  useEffect(() => { void load(false); }, [load]);

  const chosen = useMemo(() => (items ?? []).filter((i) => picked.has(i.contactId) && (i.group === 'ready' || i.group === 'in_crm' || i.group === 'no_conversation')), [items, picked]);
  const withoutStep = chosen.filter((i) => !i.ownStep && !(i.group === 'in_crm' && !createNew.has(i.contactId) && i.crmPerson?.nextAction));
  const quiet = chosen.filter((i) => i.group === 'no_conversation');
  const needsFirm = chosen.find((i) => i.firm.action === 'choose' && !firm[i.contactId]);
  const stepOk = Boolean(step.label.trim()) && Boolean(step.dueDate) && step.dueDate >= today;
  const blocked = !items ? 'Checking each contact against the CRM…'
    : !chosen.length ? 'Tick at least one contact to move.'
    : needsFirm ? `Choose the firm in the CRM for ${needsFirm.name}.`
    : withoutStep.length && !step.label.trim() ? `Say what the next step is for the ${withoutStep.length === 1 ? 'contact' : `${withoutStep.length} contacts`} without one.`
    : withoutStep.length && !stepOk ? 'Pick today or a later day for the next step.'
    : quiet.length && !confirmed ? `Confirm the ${quiet.length === 1 ? 'contact' : `${quiet.length} contacts`} with no conversation yet.`
    : null;

  const toggle = (id: string) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next); };
  const fix = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fields: Record<string, string>) => start(async () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const r = await action(fd);
    if (!r.ok) { setError(r.error ?? 'That did not work.'); return; }
    setFixing(null); setError(null);
    await load(true);
  });
  const move = () => start(async () => {
    const selection: MoveSelection[] = chosen.map((i) => ({
      contactId: i.contactId,
      mode: i.crmPerson && (i.crmPerson.sharedLine ? attachShared.has(i.contactId) : !createNew.has(i.contactId)) ? 'attach' : 'create',
      attachPersonId: i.crmPerson?.id ?? null, companyId: firm[i.contactId] ?? null, noConversation: i.group === 'no_conversation',
    }));
    const r = await queueMoveAction(selection, withoutStep.length ? { ...step, label: step.label.trim() } : null);
    if (!r.ok) { setError(r.error); return; }
    onClose();
    if (r.redirectTo) router.push(r.redirectTo); else router.refresh();
  });

  const row = (i: PreflightItem) => {
    const tickable = i.group === 'ready' || i.group === 'in_crm' || i.group === 'no_conversation';
    return <li key={i.contactId} className="flex items-start gap-3 px-3 py-2.5 text-[13px]">
      {tickable ? <input type="checkbox" className="mt-0.5" aria-label={`Move ${i.name}`} checked={picked.has(i.contactId)} onChange={() => toggle(i.contactId)} /> : <span className="w-[13px]" />}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink-900">{i.name}</span>{i.signal ? <Badge tone="green">{i.signal}</Badge> : null}{i.bouncedOn !== null ? <Badge tone="amber">Email bounced</Badge> : null}</div>
        {i.group === 'left_out' ? <div className="text-ink-600">{i.reason}</div> : null}
        {i.group === 'needs' ? <div className="space-y-1">
          {i.missing.map((m) => <div key={m.key + m.text} className="flex flex-wrap items-center gap-2 text-amber-800">
            <span>{m.text}</span>
            {m.key === 'owner' && owners.length ? (fixing === `${i.contactId}:owner`
              ? <span className="inline-flex items-center gap-1"><select aria-label={`New owner for ${i.name}`} className="!py-0.5 text-[12px]" defaultValue="" onChange={(e) => e.target.value && fix(assignContactsAction, { ids: i.contactId, userId: e.target.value, [`owner:${i.contactId}`]: i.ownerId ?? '' })}><option value="" disabled>Give it to</option>{owners.filter((o) => !i.podId || o.podIds.includes(i.podId)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></span>
              : <button type="button" className="text-[12px] text-brand-700 underline" onClick={() => setFixing(`${i.contactId}:owner`)}>Assign a new owner</button>) : null}
            {m.key === 'pod' && pods.length ? (fixing === `${i.contactId}:pod`
              ? <select aria-label={`Pod for ${i.name}`} className="!py-0.5 text-[12px]" defaultValue="" onChange={(e) => e.target.value && fix(setPodAction, { id: i.contactId, podId: e.target.value })}><option value="" disabled>Choose its pod</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              : <button type="button" className="text-[12px] text-brand-700 underline" onClick={() => setFixing(`${i.contactId}:pod`)}>Choose a pod</button>) : null}
            {m.key !== 'owner' && m.key !== 'pod' ? <Link href={contactHref(i.contactId)} className="text-[12px] text-brand-700 underline">Fix on the contact</Link> : null}
          </div>)}
        </div> : null}
        {i.group === 'in_crm' && i.crmPerson ? <div className="rounded-lg border border-sky-200/70 bg-sky-50 px-2.5 py-2 text-sky-900">
          {createNew.has(i.contactId) ? <div>Creates a new person in the CRM instead of adding history to {i.crmPerson.name}. <button type="button" className="text-[12px] underline" onClick={() => { const n = new Set(createNew); n.delete(i.contactId); setCreateNew(n); }}>Same person after all</button></div> : <>
            <div>Adds history to {i.crmPerson.name}, who is in the CRM.</div>
            <div className="text-[12px] text-sky-800">{[i.crmPerson.company, i.crmPerson.ownerName ? `Owner ${i.crmPerson.ownerName}` : null, i.crmPerson.podName, i.crmPerson.nextAction ? `Next Action: ${i.crmPerson.nextAction}${i.crmPerson.nextActionDueDate ? `, ${i.crmPerson.nextActionDueDate.slice(0, 10)}` : ''}` : 'No Next Action', `matched on ${i.crmPerson.matchedOn}`].filter(Boolean).join(' · ')}</div>
            {!i.crmPerson.ownerName || !i.crmPerson.podName ? <div className="text-[12px] text-amber-800">{i.crmPerson.name} has no {!i.crmPerson.ownerName ? 'owner' : 'pod'} in the CRM: the history lands on an unassigned record.</div> : null}
            <button type="button" className="text-[12px] underline" onClick={() => setCreateNew(new Set([...createNew, i.contactId]))}>Not the same person: create new</button>
          </>}
        </div> : null}
        {(i.group === 'ready' || i.group === 'no_conversation') && i.crmPerson?.sharedLine ? <label className="flex items-center gap-2 text-[12px] text-ink-700"><input type="checkbox" checked={attachShared.has(i.contactId)} onChange={() => { const n = new Set(attachShared); if (n.has(i.contactId)) n.delete(i.contactId); else n.add(i.contactId); setAttachShared(n); }} />Shares an office line with {i.crmPerson.name} in the CRM. Same person: add the history to {i.crmPerson.name} instead</label> : null}
        {i.plan.length ? <div className="text-ink-600">{i.plan.join(' · ')}</div> : null}
        {i.firm.action === 'choose' && tickable ? <select aria-label={`Firm for ${i.name}`} className="!py-1 text-[12px]" value={firm[i.contactId] ?? ''} onChange={(e) => setFirm({ ...firm, [i.contactId]: e.target.value })}><option value="" disabled>Choose the firm in the CRM</option>{i.firm.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.domain ? ` (${c.domain})` : ''}</option>)}</select> : null}
        {tickable && i.warnings.length ? <div className="text-[12px] text-amber-800">{i.warnings.map((w) => w.text).join(' · ')}</div> : null}
      </div>
    </li>;
  };

  return <Modal label="Move to CRM" onClose={onClose} className="max-w-2xl">
    <div className="flex max-h-[calc(100dvh-12vh-26px)] flex-col">
      <div className="border-b border-line px-5 pb-3 pt-5">
        <h2 className="text-base font-semibold text-ink-900">Move to CRM</h2>
        <p className="mt-1 text-[13px] text-ink-600">{counts ? countLine(counts) : `Checking ${ids.length === 1 ? 'the contact' : `${ids.length} contacts`} against the CRM…`}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {items ? ORDER.map((g) => {
          const list = items.filter((i) => i.group === g);
          if (!list.length) return null;
          return <section key={g} aria-label={GROUP_TITLE[g]}>
            <h3 className="mb-1 text-[12px] font-medium text-ink-500">{GROUP_TITLE[g]} · {list.length}{g === 'no_conversation' ? ': CRM details complete, but no warm call, meeting or reply yet. Tick to move them anyway.' : ''}</h3>
            <ul className="divide-y divide-line rounded-lg border border-line">{list.map(row)}</ul>
          </section>;
        }) : null}
        {quiet.length ? <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900"><input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />{quiet.length === 1 ? `${quiet[0].name} has had no conversation yet. Move them anyway.` : `${quiet.length} contacts have had no conversation yet. Move them anyway.`}</label> : null}
        {withoutStep.length ? <fieldset className="space-y-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-900">Next step</legend>
          <p className="text-[12px] text-ink-500">{chosen.length - withoutStep.length ? `${chosen.length - withoutStep.length} keep their own next step. ` : ''}{withoutStep.length === 1 ? `${withoutStep[0].name} has none, so gets this one` : `${withoutStep.length} have none, so get this one`}. It shows in Tasks for the contact&apos;s owner and goes to the CRM as the Next Action.</p>
          <label className="block text-xs text-ink-500">What<input value={step.label} maxLength={200} onChange={(e) => setStep({ ...step, label: e.target.value })} placeholder="Follow up on the intro call" className="mt-1 w-full" /></label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs text-ink-500">How<select value={step.action} onChange={(e) => setStep({ ...step, action: e.target.value as MoveNextStep['action'] })} className="mt-1"><option value="CALL">Call</option><option value="EMAIL">Email</option><option value="LINKEDIN_MESSAGE">LinkedIn message</option><option value="LINKEDIN_CONNECT">LinkedIn connect</option></select></label>
            <label className="block text-xs text-ink-500">When<input type="date" value={step.dueDate} min={today} onChange={(e) => setStep({ ...step, dueDate: e.target.value })} className="mt-1" /></label>
          </div>
          {step.action === 'EMAIL' && withoutStep.some((i) => i.bouncedOn !== null) ? <p className="text-[12px] text-amber-800">An email bounced for {withoutStep.filter((i) => i.bouncedOn !== null).map((i) => i.name).join(', ')}: choose another way, or they are left out.</p> : null}
        </fieldset> : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        {blocked ? <span className="mr-auto text-[12px] text-ink-600" role="status">{blocked}</span> : null}
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={Boolean(blocked) || pending} onClick={move}>{pending ? 'Moving' : !items ? 'Checking' : `Move ${chosen.length}`}</button>
      </div>
    </div>
  </Modal>;
}
