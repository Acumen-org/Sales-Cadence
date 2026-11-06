/*
 * Where Cold outreach lives (PLAN 3). No imports: the middleware runs this on the edge.
 *
 * The section was /sandbox until S10. Every /sandbox address, old bookmarks and Bellwether's stored
 * links included, lands on its /cold-outreach page with a temporary redirect (307), so a rollback is
 * never stuck behind a redirect a browser cached (owner, 5 Nov). The query string comes along.
 */

export const COLD_OUTREACH_BASE = '/cold-outreach';
const OLD = '/sandbox';

/** The old section's tabs, as their own pages now. */
const TAB_PATHS: Record<string, string> = { work: '/tasks', campaigns: '/campaigns', moves: '/moves', contacts: '' };

/**
 * The /cold-outreach address for an old /sandbox one, or null when the path is not the old section's.
 * `search` is the query string with or without its "?".
 */
export function coldOutreachRedirect(pathname: string, search: string): string | null {
  if (pathname !== OLD && !pathname.startsWith(`${OLD}/`)) return null;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const rest = pathname.slice(OLD.length).replace(/\/+$/, '');
  let path: string;
  if (!rest) {
    // The old list carried its tab as ?tab=; each tab is a page now.
    const tab = params.get('tab') ?? '';
    path = `${COLD_OUTREACH_BASE}${TAB_PATHS[tab] ?? ''}`;
    params.delete('tab');
    // The old Campaigns tab named its own tabs ?view=; the Campaigns page reads ?tab=.
    if (tab === 'campaigns' && params.has('view')) { params.set('tab', params.get('view')!); params.delete('view'); }
  } else {
    // A cold campaign's page is the campaign page every campaign has (B134).
    const campaign = /^\/campaigns\/([^/]+)$/.exec(rest);
    path = campaign ? `/campaigns/${campaign[1]}` : `${COLD_OUTREACH_BASE}${rest}`;
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
