'use client';

import { useState } from 'react';
import { shortDay, workingDayHint } from '@/lib/task-cues';

/**
 * Under a date: "Sat 7 Nov is not a working day. Move to Mon 9 Nov" (N103). Nothing on a working
 * day. The button moves the date; the rep may also keep the weekend on purpose.
 */
export function WorkingDayHint({ date, workingDays, onMove }: { date: string | null | undefined; workingDays: number[]; onMove: (date: string) => void }) {
  const hint = workingDayHint(date, workingDays);
  if (!hint) return null;
  return <p className="flex w-full flex-wrap items-center gap-2 text-[12px] text-amber-800" role="status">
    {hint.words}
    <button type="button" className="font-medium underline" onClick={() => onMove(hint.moveTo)}>Move to {shortDay(hint.moveTo)}</button>
  </p>;
}

/** A date field for a server form, with the same cue under it. */
export function DateWithWorkingDayHint({ name, defaultValue, min, workingDays, required, className, label }: { name: string; defaultValue: string; min?: string; workingDays: number[]; required?: boolean; className?: string; label?: string }) {
  const [date, setDate] = useState(defaultValue);
  return <>
    <input type="date" name={name} required={required} min={min} value={date} onChange={(e) => setDate(e.target.value)} className={className} aria-label={label} />
    <WorkingDayHint date={date} workingDays={workingDays} onMove={setDate} />
  </>;
}
