/**
 * One activity feed for a CRM person's Activity, an account's Activity and the "Recent activity"
 * boxes (owner, 13 Nov 2026: the old lists mixed every kind of event with nothing to tell them apart).
 * Every event is one of a few kinds, each with its own icon, colour and word; the text a reader sees
 * has the CRM's machine lines taken out.
 */
export type FeedKind = 'call' | 'email' | 'linkedin' | 'meeting' | 'note' | 'campaign';

export type FeedItem = {
  key: string;
  /** ISO instant: the feed is drawn in the browser too. */
  at: string;
  kind: FeedKind;
  /** Received (they did it) or sent (we did it); null when it is neither. */
  direction: 'in' | 'out' | null;
  title: string;
  /** The kind's word when the default does not fit: "Call step" for a campaign step. */
  label?: string | null;
  href?: string | null;
  /** Who did it: a rep, Cadence, or the person themselves. */
  who?: string | null;
  /** On an account: whom it was about. */
  person?: { name: string; href: string } | null;
  /** Where it came from when that is not obvious ("CRM note"). */
  source?: string | null;
  fields?: { label: string; value: string }[];
  /** Free text: a note, an email's words, what was said on a call. */
  body?: string | null;
  recordingHref?: string | null;
};

/** CALL, EMAIL, LINKEDIN_CONNECT, MEETING, STATE, NOTE... as a feed kind. */
export function kindOf(channelOrAction: string | null | undefined): FeedKind {
  const v = (channelOrAction ?? '').toUpperCase();
  if (v === 'CALL') return 'call';
  if (v === 'EMAIL') return 'email';
  if (v.startsWith('LINKEDIN')) return 'linkedin';
  if (v === 'MEETING') return 'meeting';
  if (v === 'NOTE') return 'note';
  return 'campaign';
}

/** "[Cadence] Email 2 sent by Alisa" -> "Email 2 sent by Alisa"; "[Email] Intro" -> "Intro". */
export function cleanTitle(title: string | null | undefined, prefix = '[Cadence]'): string {
  const t = (title ?? '').trim();
  const bare = t.startsWith(prefix) ? t.slice(prefix.length) : t.replace(/^\[[A-Za-z ]{2,20}\]/, '');
  return bare.trim() || 'Untitled';
}

/**
 * A note's words without the lines Cadence writes for machines: "Source: OBSERVED_MESSAGE (...)",
 * "... completed by Alisa in Cadence." (the title says it), "Due 2026-11-06. Managed by Cadence."
 * The campaign step and the outcome become fields.
 */
export function cleanNote(body: string | null | undefined): { body: string | null; fields: { label: string; value: string }[] } {
  const fields: { label: string; value: string }[] = [];
  const kept: string[] = [];
  for (const raw of (body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^Source: [A-Z_]+\b/.test(line)) continue;
    if (/ completed by .+ in Cadence\.$/.test(line)) continue;
    if (/^Due \d{4}-\d{2}-\d{2}\. Managed by Cadence\.$/.test(line)) continue;
    const step = /^Sequence "(.+)", step (\d+) \(day \d+\)\.$/.exec(line);
    if (step) { fields.push({ label: 'Campaign', value: `${step[1]} · step ${step[2]}` }); continue; }
    const outcome = /^Outcome: (.+?)\.?$/.exec(line);
    if (outcome) { fields.push({ label: 'Outcome', value: outcome[1] }); continue; }
    kept.push(raw.trimEnd());
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { body: text || null, fields };
}

/** Same day and same words: a CRM note Twenty also synced as a touch is one event, not two. */
export function dedupeFeed(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.kind}|${i.title.toLowerCase()}|${i.at.slice(0, 16)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const byNewest = (a: FeedItem, b: FeedItem) => b.at.localeCompare(a.at);
