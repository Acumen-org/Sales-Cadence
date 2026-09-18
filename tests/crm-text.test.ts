import { describe, expect, it } from 'vitest';
import { presentNoteBody } from '@/lib/crm-text';

describe('note bodies as a reader wants them', () => {
  it('turns a one-column markdown table into its lines and drops separator rows', () => {
    const raw = '|                    |\n| ------------------ |\n| 2026-01-21T14:21:43.015Z - Voicemail |\n| Note: Meeting Monday, 05/05 @ 1 pm CT |';
    expect(presentNoteBody(raw)).toBe('2026-01-21T14:21:43.015Z - Voicemail\nNote: Meeting Monday, 05/05 @ 1 pm CT');
  });

  it('keeps every word of a multi-column row and collapses runs of blank lines', () => {
    const raw = '| Date | Note |\n|---|---|\n| 2025-08-30 | Spoke with Vince |\n\n\n\n\nFollow up next month.  ';
    expect(presentNoteBody(raw)).toBe('Date · Note\n2025-08-30 · Spoke with Vince\n\nFollow up next month.');
  });

  it('leaves ordinary text alone', () => {
    const raw = '- Call Picked Up: Yes\n- Voicemail Left: No\n\n- Outcome: Follow Up';
    expect(presentNoteBody(raw)).toBe(raw);
    expect(presentNoteBody(null)).toBe('');
    expect(presentNoteBody('a | b')).toBe('a | b');
  });
});
