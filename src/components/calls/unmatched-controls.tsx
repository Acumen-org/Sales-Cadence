'use client';

import { useEffect, useState } from 'react';
import { ActionForm } from '@/components/action-form';
import { assignCallRepAction, attachCallContactAction, newColdContactFromCallAction, searchCallContactsAction } from '@/lib/actions/call-forms';
import type { CallContactOption } from '@/lib/calls/form-context';

/** Unmatched list: say which rep made the call (sales reps only, B127). Their form opens if the call is recent. */
export function AssignCallRep({ callId, reps }: { callId: string; reps: { id: string; name: string }[] }) {
  return <ActionForm action={assignCallRepAction} className="flex items-center gap-1.5">
    <input type="hidden" name="callId" value={callId} />
    <select name="userId" aria-label="Rep" defaultValue="" className="!w-auto !py-1 text-[13px]"><option value="" disabled>Choose rep</option>{reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
    <button type="submit" className="btn-secondary btn-sm">Give</button>
  </ActionForm>;
}

/**
 * Unmatched list: say who the call was with. A shared line offers the people it rings; any call can
 * be attached by a search of CRM people and cold contacts (B026, B127).
 */
export function AttachCallContact({ callId, candidates }: { callId: string; candidates: { kind: string; id: string; name: string }[] }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<CallContactOption[]>([]);
  useEffect(() => {
    if (query.trim().length < 2) { setFound([]); return; }
    let live = true;
    const t = setTimeout(async () => { const r = await searchCallContactsAction(query).catch(() => []); if (live) setFound(r); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);
  const options = [
    ...candidates.map((c) => ({ key: `${c.kind === 'person' ? 'person' : 'sandbox'}:${c.id}`, name: `${c.name}${c.kind === 'person' ? '' : ' (cold contact)'}` })),
    ...found.filter((f) => !candidates.some((c) => `${c.kind === 'person' ? 'person' : 'sandbox'}:${c.id}` === f.key)).map((f) => ({ key: f.key, name: `${f.name}${f.cold ? ' (cold contact)' : ''}${f.sub ? ` · ${f.sub}` : ''}` })),
  ];
  return <ActionForm action={attachCallContactAction} className="flex flex-wrap items-center gap-1.5">
    <input type="hidden" name="callId" value={callId} />
    <input type="search" aria-label="Find who it was with" placeholder="Find by name or number" value={query} onChange={(e) => setQuery(e.target.value)} className="!w-40 !py-1 text-[13px]" />
    <select name="contact" aria-label="Contact" defaultValue="" className="!w-auto !py-1 text-[13px]"><option value="" disabled>{options.length ? 'Choose contact' : 'Search first'}</option>{options.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}</select>
    <button type="submit" className="btn-secondary btn-sm">Attach</button>
  </ActionForm>;
}

/**
 * B127: a number nobody holds. The leader can add who it was as a new cold contact, with the call's
 * number; the call is attached to them and leaves this list once it has a rep too.
 */
export function NewColdContactFromCall({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="btn-ghost btn-sm">Add as a cold contact</button>;
  return <ActionForm action={newColdContactFromCallAction} className="flex flex-wrap items-center gap-1.5">
    <input type="hidden" name="callId" value={callId} />
    <input name="firstName" required aria-label="First name" placeholder="First name" className="!w-28 !py-1 text-[13px]" />
    <input name="lastName" required aria-label="Last name" placeholder="Last name" className="!w-28 !py-1 text-[13px]" />
    <input name="companyName" aria-label="Firm" placeholder="Firm" className="!w-32 !py-1 text-[13px]" />
    <button type="submit" className="btn-secondary btn-sm">Add and attach</button>
    <button type="button" onClick={() => setOpen(false)} className="btn-ghost btn-sm">Cancel</button>
  </ActionForm>;
}
