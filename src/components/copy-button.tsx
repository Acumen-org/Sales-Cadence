'use client';

import { useState } from 'react';
import { IconCopy } from './icons';

export function CopyButton({ text, label = 'Copy', className = 'btn-secondary btn-sm' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 1500);
      }}
    >
      <IconCopy size={14} />
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}
