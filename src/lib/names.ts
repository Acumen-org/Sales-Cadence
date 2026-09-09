/** First name from a full name, for the short forms used in notes and write-backs. */
export function firstNameOf(name: string | null | undefined): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] ?? '';
}
