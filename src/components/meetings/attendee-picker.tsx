'use client';

import { useEffect, useState } from 'react';
import { searchMeetingAttendeesAction, type AttendeeOption, type AttendeeSelection } from '@/lib/actions/meetings';
import { Avatar, Badge } from '@/components/ui';

const keyOf = (a: AttendeeSelection) => a.userId ? `user:${a.userId}` : a.personId ? `person:${a.personId}` : a.email?.toLowerCase() ?? a.name?.toLowerCase() ?? '';

export function AttendeePicker({ initial, name = 'attendeesJson' }: { initial: AttendeeSelection[]; name?: string }) {
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<AttendeeOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true); setError('');
      try { const rows = await searchMeetingAttendeesAction(query); if (!cancelled) setOptions(rows); }
      catch { if (!cancelled) setError('Unable to search attendees. Try again.'); }
      finally { if (!cancelled) setLoading(false); }
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, open]);
  const add = (person: AttendeeSelection) => {
    if (selected.length >= 200) { setError('A meeting can include up to 200 attendees.'); return; }
    setSelected((items) => items.some((a) => keyOf(a) === keyOf(person) || Boolean(a.email && person.email && a.email.toLowerCase() === person.email.toLowerCase())) ? items : [...items, person]);
    setQuery(''); setOpen(false);
  };

  const visibleOptions = options.filter((o) => !selected.some((a) => keyOf(a) === keyOf(o) || Boolean(a.email && o.email && a.email.toLowerCase() === o.email.toLowerCase())));

  return <div className="space-y-3">
    <input name={name} type="hidden" value={JSON.stringify(selected)} />
    {selected.length ? <ul className="divide-y divide-line rounded-xl border border-line">{selected.map((a) => <li key={keyOf(a)} className="flex items-center gap-3 p-3">
      <Avatar name={a.name ?? a.email ?? '?'} shape="circle" size={30} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-ink-900">{a.name ?? a.email}</div>{a.name && a.email ? <div className="truncate text-xs text-ink-500">{a.email}</div> : null}</div>
      <Badge tone={a.userId ? 'blue' : 'gray'}>{a.userId ? 'Team' : a.personId ? 'Contact' : 'Guest'}</Badge><button type="button" onClick={() => setSelected((items) => items.filter((item) => keyOf(item) !== keyOf(a)))} className="btn-ghost btn-sm" aria-label={`Remove ${a.name ?? a.email}`}>Remove</button>
    </li>)}</ul> : null}
    <div className="relative">
      <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } if (event.key === 'Enter') event.preventDefault(); }} aria-label="Find a contact or team member" placeholder="Find a contact or team member" />
      {open ? <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-surface" role="region" aria-label="Attendee search results">
        <div className="flex items-center justify-between px-2 py-1"><span className="text-xs text-ink-500">{loading ? 'Searching…' : 'Contacts and team'}</span><button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>Close</button></div>
        {visibleOptions.map((option) => <button key={option.key} type="button" onClick={() => add(option)} className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-canvas">
          <Avatar name={option.name ?? option.email ?? '?'} shape="circle" size={28} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-ink-900">{option.name ?? option.email}</span><span className="block truncate text-xs font-medium text-ink-700">{option.detail ?? option.email}</span></span><Badge tone={option.kind === 'team' ? 'blue' : 'gray'}>{option.kind === 'team' ? 'Team' : 'Contact'}</Badge>
        </button>)}
        {/* Every outcome says something. A dropdown that goes blank looks like a broken search. */}
        {error ? <p role="alert" className="p-3 text-sm font-medium text-red-700">{error}</p> : null}
        {!loading && !error && !visibleOptions.length ? <div className="p-3 text-sm text-ink-500">{query.trim() ? 'No matching people' : 'Start typing a name, email or company'}</div> : null}
      </div> : null}
    </div>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    <button type="button" className="btn-ghost btn-sm" onClick={() => setGuestOpen(!guestOpen)} aria-expanded={guestOpen}>Add someone outside the directory</button>
    {guestOpen ? <div className="space-y-2 rounded-xl bg-canvas p-3"><input value={guestName} onChange={(e) => setGuestName(e.target.value)} aria-label="Guest name" placeholder="Name" maxLength={200} /><input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} aria-label="Guest email" placeholder="Email (optional)" maxLength={254} /><button type="button" className="btn-secondary btn-sm" disabled={!guestName.trim() && !guestEmail.trim()} onClick={() => { if (guestEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail.trim())) { setError('Enter a valid guest email.'); return; } add({ name: guestName.trim() || null, email: guestEmail.trim().toLowerCase() || null }); setGuestName(''); setGuestEmail(''); setGuestOpen(false); setError(''); }}>Add attendee</button></div> : null}
  </div>;
}
