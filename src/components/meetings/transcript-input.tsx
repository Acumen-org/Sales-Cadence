'use client';

import { useState } from 'react';

/**
 * The transcript, pasted or uploaded. A .vtt, .srt, .json or .txt file is read in the browser
 * and lands in the same textarea, so the form submits one field either way.
 */
export function TranscriptInput({ name, label, defaultValue, value: providedValue, rows = 6, placeholder = 'Paste the transcript, or choose a file', onChange }: { name: string; label: string; defaultValue?: string | null; value?: string; rows?: number; placeholder?: string; onChange?: (value: string) => void }) {
  const [raw, setRaw] = useState(defaultValue ?? '');
  const value = providedValue ?? raw;
  const setValue = (next: string) => { setRaw(next); onChange?.(next); };
  const [fileName, setFileName] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <textarea name={name} aria-label={label} rows={rows} value={value} onChange={(e) => setValue(e.target.value)} className="w-full font-mono !text-[12px]" placeholder={placeholder} />
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-500">
        <label className="btn-secondary btn-sm cursor-pointer">
          Choose a file
          <input
            type="file"
            accept=".vtt,.srt,.json,.txt,text/vtt,application/json,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setValue(await f.text());
              setFileName(f.name);
            }}
          />
        </label>
        {fileName ? <span>{fileName}</span> : <span>WebVTT, SRT, Teams grouped text, JSON export or plain text</span>}
        {value ? <button type="button" className="btn-ghost btn-sm ml-auto" onClick={() => { setValue(''); setFileName(null); }}>Clear</button> : null}
      </div>
    </div>
  );
}
