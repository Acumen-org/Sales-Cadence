/**
 * The part of a meeting link that names the meeting: host and path, without the ?authuser=1 or
 * tracking a browser adds. "meet.google.com/abc-defg-hij" whatever was around it.
 */
export function linkKey(url: string): string | null {
  try {
    const u = new URL(url.trim());
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
    const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^[a-z0-9-]+\.zoom\.us$/, 'zoom.us');
    return `${host}${path.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * What to search the stored links for: the link's longest run of letters and digits (a Meet code,
 * a Zoom number, a Teams meeting id), which reads the same whether the link was stored encoded or not.
 */
export function linkNeedle(url: string): string | null {
  const key = linkKey(url);
  if (!key) return null;
  const path = key.slice(key.indexOf('/'));
  const runs = path.match(/[a-z0-9_-]{6,}/g) ?? [];
  return runs.sort((a, b) => b.length - a.length)[0] ?? null;
}
