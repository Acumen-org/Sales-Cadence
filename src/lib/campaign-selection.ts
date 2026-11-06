'use client';

/** Keep large audience selections out of URLs; validation still happens on the server. */
export function campaignSelectionUrl(path: string, personIds: string[], extra: Record<string, string> = {}) {
  const token = crypto.randomUUID();
  sessionStorage.setItem(`campaign-selection:${token}`, JSON.stringify({ ids: personIds, savedAt: Date.now() }));
  return `${path}?${new URLSearchParams({ ...extra, selection: token }).toString()}`;
}

export function readCampaignSelection(token: string | null): string[] {
  if (!token) return [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(`campaign-selection:${token}`) ?? 'null');
    if (!saved || Date.now() - saved.savedAt > 86400000 || !Array.isArray(saved.ids) || saved.ids.length > 10000) return [];
    return saved.ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  } catch { return []; }
}
