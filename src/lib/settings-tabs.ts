/**
 * Which Settings tab a request opens. Admins open any tab. Everyone else opens Settings > Cold outreach
 * read only, with who can change it (B215), never a silent trip to Tasks. The tab's old key, `sandbox`,
 * still works: it redirects to the new one.
 */
export const COLD_OUTREACH_SETTINGS_TAB = 'cold-outreach';
/** The read-only page any signed-in user may open, e.g. from the Cold outreach section's header. */
export const COLD_OUTREACH_SETTINGS_HREF = `/settings?tab=${COLD_OUTREACH_SETTINGS_TAB}`;

const RENAMED: Record<string, string> = { sandbox: COLD_OUTREACH_SETTINGS_TAB };

export function settingsRoute(asked: string | undefined, admin: boolean, keys: readonly string[]): { tab: string } | { redirect: string } {
  if (asked && RENAMED[asked]) return { redirect: `/settings?tab=${RENAMED[asked]}` };
  if (!admin) return asked === COLD_OUTREACH_SETTINGS_TAB ? { tab: asked } : { redirect: COLD_OUTREACH_SETTINGS_HREF };
  // An unknown or empty tab opens the first one rather than a page with nothing on it.
  return { tab: asked && keys.includes(asked) ? asked : keys[0] };
}
