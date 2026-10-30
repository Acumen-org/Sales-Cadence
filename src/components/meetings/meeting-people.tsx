'use client';

import { useEffect, useId, useRef, useState } from 'react';
import clsx from 'clsx';
import { prospectNumbersAction, searchProspectsAction, searchTeamAction, type ProspectNumber, type ProspectOption, type TeamOption } from '@/lib/actions/meetings';
import { formatLocalDate } from '@/lib/dates';
import { Avatar, Badge } from '@/components/ui';
import { IconClose, IconSearch } from '@/components/icons';

export type PeopleValue = { bookedById: string; team: TeamOption[]; prospects: ProspectOption[] };

/** "1st", "2nd", "3rd", "11th". */
function ordinal(n: number): string {
  const tens = n % 100;
  return `${n}${tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * A search box with its results underneath, driven from the keyboard as well as the mouse. The
 * results come from the server; what is already chosen is left out.
 */
function Finder<T>({ label, placeholder, search, keyOf, render, onPick, exclude, openOnFocus, empty }: {
  label: string;
  placeholder: string;
  search: (q: string) => Promise<T[]>;
  keyOf: (item: T) => string;
  render: (item: T) => React.ReactNode;
  onPick: (item: T) => void;
  exclude: Set<string>;
  /** Lists everyone before anything is typed (the team is short). */
  openOnFocus?: boolean;
  empty: (q: string) => string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const shown = items.filter((i) => !exclude.has(keyOf(i)));

  useEffect(() => {
    if (!open || (!q.trim() && !openOnFocus)) { setItems([]); return; }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try { const rows = await search(q); if (!cancelled) { setItems(rows); setFailed(false); setActive(0); } }
      catch { if (!cancelled) setFailed(true); }
      finally { if (!cancelled) setLoading(false); }
    }, q.trim() ? 180 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // `search` is a server action reference and stable; the query and openness drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, openOnFocus]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (item: T) => { onPick(item); setQ(''); setActive(0); };
  const showList = open && (q.trim() || openOnFocus);

  return (
    <div ref={box} className="relative">
      <div className="relative">
        <IconSearch size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          type="search"
          role="combobox"
          aria-label={label}
          aria-expanded={Boolean(showList)}
          aria-controls={listId}
          autoComplete="off"
          value={q}
          placeholder={placeholder}
          className="!pl-8"
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); }
          }}
        />
      </div>
      {showList ? (
        <div id={listId} role="listbox" aria-label={`${label} results`} className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-lg">
          {shown.map((item, i) => (
            <button
              key={keyOf(item)}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(item)}
              className={clsx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left', i === active ? 'bg-brand-50' : 'hover:bg-canvas')}
            >
              {render(item)}
            </button>
          ))}
          {loading && !shown.length ? <div className="px-3 py-2.5 text-[13px] text-ink-500">Searching…</div> : null}
          {failed ? <div role="alert" className="px-3 py-2.5 text-[13px] text-red-700">The search did not answer. Type again to retry.</div> : null}
          {!loading && !failed && !shown.length ? <div className="px-3 py-2.5 text-[13px] text-ink-500">{empty(q.trim())}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The number on a prospect, with what it counts on hover: the earlier meetings, and this one. */
function MeetingNumber({ name, info }: { name: string; info: ProspectNumber | undefined }) {
  const tipId = useId();
  if (!info) return <span className="text-[12px] text-ink-400">Counting…</span>;
  const first = info.number === 1;
  const earlier = info.earlier.map((d) => formatLocalDate(d, 'short'));
  const tip = [
    first ? `The first meeting with ${name} in Cadence.` : `The ${ordinal(info.number)} meeting with ${name} in Cadence, counting this one. Earlier: ${earlier.join(', ')}.`,
    info.later ? `${info.later} later ${info.later === 1 ? 'meeting moves' : 'meetings move'} up one.` : null,
  ].filter(Boolean).join(' ');
  return (
    <span className="group relative inline-flex">
      <span tabIndex={0} aria-describedby={tipId} className={clsx('cursor-help rounded-full border px-2.5 py-0.5 text-[12px] font-medium tabular-nums underline decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-brand-300', first ? 'border-emerald-200 bg-emerald-50 text-emerald-800 decoration-emerald-400' : 'border-line bg-canvas text-ink-700 decoration-ink-300')}>
        {first ? '1st meeting' : `${ordinal(info.number)} meeting`}
      </span>
      <span id={tipId} role="tooltip" className="pointer-events-none absolute right-0 top-full z-40 mt-1.5 w-64 rounded-lg bg-ink-900 px-3 py-2 text-[12px] leading-snug text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100">
        {tip}
      </span>
    </span>
  );
}

/**
 * Who was there, in three parts: the FO who booked it (credited with it), the team on the call,
 * and the prospects. Every prospect shows which meeting with them this is, counted from Cadence's
 * own meetings as the date and the list change, and the meeting as a whole is the highest of
 * those: a first meeting only when everyone on it is new.
 */
export function MeetingPeople({ fos, value, onChange, day, meetingId, showBookedBy = true }: {
  fos: { id: string; name: string }[];
  value: PeopleValue;
  onChange: (next: PeopleValue) => void;
  /** The meeting's day, YYYY-MM-DD: numbers follow it. */
  day: string;
  meetingId: string | null;
  showBookedBy?: boolean;
}) {
  const [numbers, setNumbers] = useState<ProspectNumber[]>([]);
  const ids = value.prospects.map((p) => p.personId);
  const idsKey = ids.join(',');
  useEffect(() => {
    if (!ids.length) { setNumbers([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const rows = await prospectNumbersAction(ids, day, meetingId).catch(() => []);
      if (!cancelled) setNumbers(rows);
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, day, meetingId]);

  const numberOf = (personId: string) => numbers.find((n) => n.personId === personId);
  const known = value.prospects.map((p) => numberOf(p.personId)?.number).filter((n): n is number => typeof n === 'number');
  const overall = known.length === value.prospects.length && known.length ? Math.max(...known) : null;
  const booker = fos.find((f) => f.id === value.bookedById)?.name;
  const set = (patch: Partial<PeopleValue>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-5">
      <input type="hidden" name="teamJson" value={JSON.stringify(value.team.map((t) => t.userId))} />
      <input type="hidden" name="prospectsJson" value={JSON.stringify(ids)} />

      {showBookedBy ? (
        <div className="grid gap-1.5 md:max-w-sm">
          <div className="flex items-center"><label htmlFor="meeting-booked-by">Booked by</label><span className="ml-0.5 text-[12px] leading-4 text-red-600" aria-hidden>*</span></div>
          <select id="meeting-booked-by" name="bookedById" required value={value.bookedById} onChange={(e) => set({ bookedById: e.target.value })}>
            <option value="">Choose the FO</option>
            {fos.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center"><span id="team-label" className="text-[12px] font-medium text-ink-500">Our team on the call</span><span className="ml-0.5 text-[12px] leading-4 text-red-600" aria-hidden>*</span></div>
        {value.team.length ? (
          <ul aria-labelledby="team-label" className="flex flex-wrap gap-1.5">
            {value.team.map((t) => (
              <li key={t.userId} className="flex items-center gap-2 rounded-full border border-line bg-white py-1 pl-1 pr-1.5 text-[13px] text-ink-800">
                <Avatar name={t.name} shape="circle" size={22} />
                <span>{t.name}</span>
                <button type="button" aria-label={`Remove ${t.name}`} onClick={() => set({ team: value.team.filter((x) => x.userId !== t.userId) })} className="grid h-5 w-5 place-items-center rounded-full text-ink-400 hover:bg-canvas hover:text-ink-700"><IconClose size={12} /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="md:max-w-md">
          <Finder<TeamOption>
            label="Add someone from the team"
            placeholder="Add someone from the team"
            search={searchTeamAction}
            keyOf={(t) => t.userId}
            exclude={new Set(value.team.map((t) => t.userId))}
            openOnFocus
            onPick={(t) => set({ team: [...value.team, t] })}
            empty={(q) => (q ? `No one on the team matches "${q}"` : 'Everyone on the team is added')}
            render={(t) => <>
              <Avatar name={t.name} shape="circle" size={26} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink-900">{t.name}</span><span className="block truncate text-[12px] text-ink-500">{[t.title, t.email].filter(Boolean).join(' · ')}</span></span>
            </>}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center"><span id="prospects-label" className="text-[12px] font-medium text-ink-500">Prospects</span><span className="ml-0.5 text-[12px] leading-4 text-red-600" aria-hidden>*</span></div>
        {value.prospects.length ? (
          <ul aria-labelledby="prospects-label" className="divide-y divide-line rounded-xl border border-line bg-white">
            {value.prospects.map((p) => (
              <li key={p.personId} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar name={p.name} shape="circle" size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-ink-900">{p.name}</span>
                  <span className="block truncate text-[12px] text-ink-500">{[p.companyName, p.email].filter(Boolean).join(' · ')}</span>
                </span>
                <MeetingNumber name={p.name} info={numberOf(p.personId)} />
                <button type="button" aria-label={`Remove ${p.name}`} onClick={() => set({ prospects: value.prospects.filter((x) => x.personId !== p.personId) })} className="grid h-7 w-7 place-items-center rounded-lg text-ink-400 hover:bg-canvas hover:text-ink-700"><IconClose size={14} /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <Finder<ProspectOption>
          label="Find a prospect in Twenty"
          placeholder="Find a prospect in Twenty: name, email or company"
          search={searchProspectsAction}
          keyOf={(p) => p.personId}
          exclude={new Set(ids)}
          onPick={(p) => set({ prospects: [...value.prospects, p] })}
          empty={(q) => `No one in Twenty matches "${q}"`}
          render={(p) => <>
            <Avatar name={p.name} shape="circle" size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink-900">{p.name}</span>
              <span className="block truncate text-[12px] text-ink-500">{[p.jobTitle, p.companyName].filter(Boolean).join(' at ') || p.email}</span>
            </span>
            {p.email && (p.jobTitle || p.companyName) ? <span className="hidden max-w-[40%] truncate text-[12px] text-ink-500 md:block">{p.email}</span> : null}
          </>}
        />
        {overall ? (
          <div className="flex flex-wrap items-center gap-2 pt-1 text-[13px] text-ink-600" aria-live="polite">
            <span>This meeting</span>
            <Badge tone={overall === 1 ? 'green' : 'gray'}>{overall === 1 ? 'First meeting' : `Follow-up · ${ordinal(overall)} meeting`}</Badge>
            {booker ? <span>for {booker}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
