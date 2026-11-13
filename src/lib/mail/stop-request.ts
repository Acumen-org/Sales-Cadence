/**
 * Audit L02: a reply that asks us to stop is an opt-out across every campaign, never just one ended
 * as "Replied". Cadence reads only a sales mailbox's subject (never the body: graph-mail.ts), so
 * there the subject is the signal; a reply synced through the CRM also carries its text. Only the
 * reply's own words count: the quoted email below it (which may carry our own footer) is cut off
 * first, and a subject counts as a whole ("Re: STOP"), so "Stop overpaying" is not a request.
 */

const STOP_PHRASES = [
  /\bunsubscribe\b/i,
  /\b(stop|quit|cease)\s+(e-?mailing|contacting|calling|messaging|writing|sending)\b/i,
  /\b(please\s+)?remove\s+me\b/i,
  /\btake\s+me\s+off\b/i,
  /\bopt\s+me\s+out\b|\b(i\s+(want|wish|would\s+like)\s+to|please)\s+opt[\s-]?out\b/i,
  /\b(do\s+not|don'?t|never)\s+(contact|e-?mail|call|message|write\s+to)\s+(me|us)\b/i,
  /\bno\s+more\s+(e-?mails|messages|calls)\b/i,
  /\bleave\s+me\s+alone\b/i,
];
const SUBJECT_PHRASES = STOP_PHRASES.filter((_, i) => i !== 2 && i !== 4);
const WHOLE_SUBJECT = /^(stop|unsubscribe|remove( me)?|opt[\s-]?out|do not (contact|e-?mail)( me)?)[.!\s]*$/i;
const PREFIX = /^\s*((re|fw|fwd|aw|sv|antw)\s*:\s*)+/i;
/** Where a reply's own words end and the quoted email begins. */
const QUOTE_START = /^(>|-{2,}\s*original message|on .{4,200} wrote:|from:\s|sent:\s|_{5,})/im;

/** The part of a reply its sender wrote, before any quoted email, at most 2,000 characters. */
export function replyOwnText(text: string | null | undefined): string {
  if (!text) return '';
  const cut = text.search(QUOTE_START);
  return (cut >= 0 ? text.slice(0, cut) : text).slice(0, 2000);
}

/** Does this reply ask not to be contacted? The subject as a whole, or a stop phrase in it or in the sender's own text. */
export function asksToStop(subject: string | null | undefined, text?: string | null): boolean {
  const s = (subject ?? '').replace(PREFIX, '').trim();
  if (s && WHOLE_SUBJECT.test(s)) return true;
  // A subject is mostly the rep's own ("Opt out of high fees?"), so only phrases no rep would write count there.
  if (s && SUBJECT_PHRASES.some((p) => p.test(s))) return true;
  const own = replyOwnText(text);
  return Boolean(own) && STOP_PHRASES.some((p) => p.test(own));
}
