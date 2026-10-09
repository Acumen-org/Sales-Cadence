/**
 * Validation problems in words a person reads, not the form's field names: "sourceUrl: Use an
 * http..." reads "Use an http...", and "callDispositions.7.label: String must contain at least 1
 * character(s)" reads "Call outcome 8: the label cannot be empty".
 */
type Issue = { path: (string | number)[]; message: string };

const NAMES: Record<string, string> = {
  callDispositions: 'Call outcome',
  skipReasons: 'Skip reason',
  internalDomains: 'Internal domain',
  workingDays: 'Working days',
  bookedById: 'Booked by',
  occurredAt: 'Date and time',
  sourceUrl: 'Recording link',
  companyId: 'Account',
  durationSec: 'Duration',
};

const words = (name: string) => NAMES[name] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function plain(message: string): string {
  const atLeast = /^String must contain at least (\d+) character\(s\)$/.exec(message);
  if (atLeast) return atLeast[1] === '1' ? 'cannot be empty' : `needs at least ${atLeast[1]} characters`;
  const atMost = /^String must contain at most (\d+) character\(s\)$/.exec(message);
  if (atMost) return `is too long (at most ${atMost[1]} characters)`;
  if (message === 'Required') return 'is required';
  if (/^Expected .* received/.test(message) || /^Invalid/.test(message)) return 'is not valid';
  return message;
}

export function issueText(issues: Issue[]): string {
  return [...new Set(issues.map((i) => {
    const message = plain(i.message);
    // A sentence the schema wrote for people already says what is wrong.
    if (/^[A-Z]/.test(message)) return message;
    const parts: string[] = [];
    for (let k = 0; k < i.path.length; k++) {
      const p = i.path[k];
      if (typeof p === 'number') { if (parts.length) parts[parts.length - 1] += ` ${p + 1}`; continue; }
      parts.push(parts.length ? `the ${words(p).toLowerCase()}` : words(p));
    }
    const where = parts.length > 1 ? `${parts[0]}: ${parts.slice(1).join(' ')}` : parts[0] ?? 'This field';
    return `${where} ${message}`;
  }))].join('; ');
}
