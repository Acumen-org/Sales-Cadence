import { parseMeetingLink } from './providers';

/**
 * A recording link that plays natively is the one whose transcript can follow the audio. SharePoint
 * and OneDrive sharing links usually hand out the file itself when asked with `download=1`, and a
 * Google Drive file does the same through `uc?export=download`, so the server asks once when the
 * meeting is saved and keeps the direct address if the answer is video or audio. Anything else -
 * a page, a sign-in wall, a refusal - leaves the embed path as it was. Nothing here is guessed.
 */
const TIMEOUT_MS = 6000;

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

export function candidateMediaUrls(raw: string): string[] {
  let url: URL;
  try { url = new URL(raw); } catch { return []; }
  if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return [];
  const host = url.hostname.toLowerCase();
  const out: string[] = [];
  if (host.endsWith('.sharepoint.com') || host === '1drv.ms' || host.endsWith('.svc.ms')) {
    const withDownload = new URL(url.toString());
    withDownload.searchParams.set('download', '1');
    out.push(withDownload.toString());
  }
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const id = /\/file\/d\/([^/]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
    if (id) out.push(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`);
  }
  out.push(url.toString());
  return [...new Set(out)];
}

async function probe(url: string, fetchImpl: typeof fetch): Promise<{ finalUrl: string; type: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // A ranged GET rather than HEAD: some hosts answer HEAD with HTML and GET with the file.
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', headers: { range: 'bytes=0-0', accept: 'video/*,audio/*,*/*;q=0.5' }, signal: controller.signal });
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!res.ok && res.status !== 206) return null;
    return { finalUrl: res.url || url, type };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The direct media address behind a link, or null when the link does not hand one out. */
export async function resolveDirectMedia(raw: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const parsed = parseMeetingLink(raw);
  if (parsed.mediaUrl) return parsed.mediaUrl;
  if (parsed.isJoinLink) return null;
  for (const candidate of candidateMediaUrls(raw)) {
    const hit = await probe(candidate, fetchImpl);
    if (hit && (hit.type.startsWith('video/') || hit.type.startsWith('audio/'))) return hit.finalUrl;
  }
  return null;
}

export type LinkInspection = {
  title: string | null;
  description: string | null;
  /** YYYY-MM-DD read off the page, when it carries one. */
  date: string | null;
  mediaUrl: string | null;
};

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };

/** A date written any of the common ways, as YYYY-MM-DD; the first one found. */
export function dateInText(text: string): string | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/i.exec(text);
  if (dmy) return `${dmy[3]}-${MONTHS[dmy[2].toLowerCase().slice(0, 4).replace(/\.$/, '')] ?? MONTHS[dmy[2].toLowerCase().slice(0, 3)]}-${dmy[1].padStart(2, '0')}`;
  const mdy = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(text);
  if (mdy) return `${mdy[3]}-${MONTHS[mdy[1].toLowerCase().slice(0, 4).replace(/\.$/, '')] ?? MONTHS[mdy[1].toLowerCase().slice(0, 3)]}-${mdy[2].padStart(2, '0')}`;
  const numeric = /\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/.exec(text);
  if (numeric) {
    // Day first when the first number cannot be a month, otherwise the workspace's US habit.
    const [a, b] = [Number(numeric[1]), Number(numeric[2])];
    const [month, day] = a > 12 ? [b, a] : [a, b];
    return `${numeric[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
  const m = re.exec(html) ?? alt.exec(html);
  return m ? decode(m[1]) : null;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** What a link's page says about itself: its title, description and a date, plus a direct media address. */
export async function inspectLink(raw: string, fetchImpl: typeof fetch = fetch): Promise<LinkInspection> {
  const out: LinkInspection = { title: null, description: null, date: null, mediaUrl: null };
  let url: URL;
  try { url = new URL(raw); } catch { return out; }
  if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return out;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.toString(), { redirect: 'follow', headers: { accept: 'text/html,*/*;q=0.5' }, signal: controller.signal });
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type.startsWith('video/') || type.startsWith('audio/')) { out.mediaUrl = res.url || url.toString(); return out; }
    if (res.ok && type.includes('html')) {
      const html = (await res.text()).slice(0, 300_000);
      out.title = meta(html, 'og:title') ?? (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)![1]) : null);
      out.description = meta(html, 'og:description') ?? meta(html, 'description');
      const stamped = meta(html, 'article:published_time') ?? meta(html, 'og:updated_time') ?? meta(html, 'date');
      out.date = (stamped ? dateInText(stamped) : null) ?? dateInText(`${out.title ?? ''} ${out.description ?? ''}`) ?? dateInText(decodeURIComponent(url.pathname));
      const video = meta(html, 'og:video') ?? meta(html, 'og:video:url');
      if (video && /\.(mp4|webm|m4v|mov|ogg|ogv)(\?|#|$)/i.test(video)) out.mediaUrl = video;
    }
  } catch {
    // The page could not be read: the form keeps what was typed.
  } finally {
    clearTimeout(timer);
  }
  if (!out.mediaUrl) out.mediaUrl = await resolveDirectMedia(raw, fetchImpl);
  if (!out.date) out.date = dateInText(decodeURIComponent(url.pathname + ' ' + url.search));
  return out;
}
