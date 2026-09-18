/**
 * Every Call button and phone number opens the team's dialpad (decision of 18 September 2026).
 * The address is a setting with `{phone}` where the number goes; blank falls back to a tel: link
 * so a machine's own dialler still works.
 */
export const DEFAULT_DIALPAD_URL = 'https://h00ks.acm.acumen-strategy.com/admin/dialpad?number={phone}';

/** Digits and a leading plus only, the way a dialler wants it. */
export function dialable(phone: string): string {
  const trimmed = phone.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/[^\d]/g, '');
}

export function callHref(phone: string, template: string | null | undefined): string {
  const number = dialable(phone);
  const t = (template ?? '').trim();
  if (!t) return `tel:${number}`;
  return t.includes('{phone}') ? t.replace('{phone}', encodeURIComponent(number)) : t;
}

/** Whether the setting points at a page to open (true) rather than a dialler on the machine. */
export function opensDialpad(template: string | null | undefined): boolean {
  return Boolean((template ?? '').trim());
}
