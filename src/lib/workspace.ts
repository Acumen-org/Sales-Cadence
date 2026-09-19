export const WORKSPACE_TIMEZONE = 'America/Chicago';

/**
 * The timezone the workspace runs on: the day a task belongs to, the reconcile hour, every date
 * without a person's own clock. Central Time unless an admin changes it on Settings > Rules. Read
 * from the settings cache so the many synchronous callers need no await; the cache is warm from
 * the first request of every process, and the constant stands in until then.
 */
export function workspaceTimezone(): string {
  const g = globalThis as unknown as { __cadenceSettingsCache?: { value?: { rules?: { workspaceTimezone?: string } } } };
  return g.__cadenceSettingsCache?.value?.rules?.workspaceTimezone || WORKSPACE_TIMEZONE;
}

/** Common choices for the setting; any IANA zone is accepted. */
export const TIMEZONE_CHOICES: { value: string; label: string }[] = [
  { value: 'America/Chicago', label: 'US Central' },
  { value: 'America/New_York', label: 'US Eastern' },
  { value: 'America/Denver', label: 'US Mountain' },
  { value: 'America/Phoenix', label: 'US Arizona' },
  { value: 'America/Los_Angeles', label: 'US Pacific' },
  { value: 'America/Toronto', label: 'Canada Eastern' },
  { value: 'Europe/London', label: 'UK' },
  { value: 'Europe/Berlin', label: 'Central Europe' },
  { value: 'Asia/Kolkata', label: 'India' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];
export const timezoneLabel = (tz: string) => TIMEZONE_CHOICES.find((c) => c.value === tz)?.label ?? tz;
export const WORKSPACE_TIMEZONE_LABEL = 'US Central';
/**
 * The assistant is named after the product so nobody has to learn a second brand for it. One
 * name, one icon (IconAssistant) and one panel (components/assistant.tsx) wherever it appears.
 */
/**
 * What the team sells. A meeting can be about more than one, which is why it is a list rather
 * than a select.
 *
 * These three, and only these three. Twenty's `productInterest` select also carries TOLLBOOTH,
 * which is deliberately not offered here - the owner named the three a meeting can be about. If
 * that changes, add it here; a value stored outside this list is dropped the next time anything
 * on the meeting is toggled.
 */
export const PRODUCTS = ['PHH', 'ACUBOOTH', 'GLYNAC'] as const;
export type Product = (typeof PRODUCTS)[number];

export const ASSISTANT_NAME = 'Cadence AI';
export const ASSISTANT_SETTINGS_TAB = 'ai';
