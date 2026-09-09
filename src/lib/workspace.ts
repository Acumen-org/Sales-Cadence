export const WORKSPACE_TIMEZONE = 'America/Chicago';
export const WORKSPACE_TIMEZONE_LABEL = 'US Central';
/**
 * The assistant is named after the product so nobody has to learn a second brand for it. One
 * name, one icon (IconAssistant) and one panel (components/assistant.tsx) wherever it appears.
 */
/**
 * What the team sells. A meeting can be about more than one, which is why it is a list rather
 * than a select. The values are Twenty's own product constants, so a meeting tagged here reads
 * the same as a contact's product interest.
 */
export const PRODUCTS = ['PHH', 'ACUBOOTH', 'GLYNAC'] as const;
export type Product = (typeof PRODUCTS)[number];

export const ASSISTANT_NAME = 'Cadence AI';
export const ASSISTANT_SETTINGS_TAB = 'ai';
