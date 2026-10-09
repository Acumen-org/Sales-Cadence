import type { MeetingProvider } from '@prisma/client';

/**
 * Turn a pasted recording link into something the app can play.
 *
 * Reality check on embedding, because it decides what the UI can do:
 *  - **SharePoint / Microsoft Stream** (where Teams recordings land) frames only its own embed
 *    player: the `_layouts/15/embed.aspx` link from Share > Embed. A sharing link is the full
 *    SharePoint page and refuses to be framed. The viewer must be signed in to Microsoft 365.
 *  - **Google Drive** (where Meet recordings land) supports `/file/d/<id>/preview` in an iframe.
 *  - **Direct media files** (.mp4/.webm/.m4v/.ogg) play natively in a <video> element.
 *  - **Zoom cloud recordings** refuse to be framed (they send X-Frame-Options/CSP), so Cadence
 *    links out instead. If the recording is downloaded and hosted somewhere, paste that URL and
 *    it plays inline.
 *  - **Live meeting links** (teams.microsoft.com/l/meetup-join, meet.google.com/abc-defg-hij,
 *    zoom.us/j/123) are joins, not recordings: they are stored and linked, never framed.
 */
export type ParsedMeetingLink = {
  provider: MeetingProvider;
  /** URL to put in an iframe, or null when the provider forbids framing. */
  embedUrl: string | null;
  /** Direct media URL for a <video> element, when the link is a file. */
  mediaUrl: string | null;
  /** True when this is a join link rather than a recording. */
  isJoinLink: boolean;
  /** Human label, e.g. "Microsoft Teams (SharePoint)". */
  label: string;
  /** Why it cannot be embedded, when it cannot. */
  note: string | null;
};

const MEDIA_EXT = /\.(mp4|webm|m4v|ogv|ogg|mov|mp3|wav|m4a|aac|flac)(\?|#|$)/i;
const isHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * What somebody pasted, reduced to the link inside it. SharePoint's Share > Embed hands out a whole
 * `<iframe src="...">` tag, not a URL, and the form is the wrong place to make anyone dig the address
 * out of it: the src is taken, HTML entities are undone, and everything else is dropped.
 */
export function extractRecordingUrl(raw: string): string {
  const text = raw.trim();
  const src = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(text)?.[1] ?? (text.includes('<') ? /https?:\/\/[^\s"'<>]+/i.exec(text)?.[0] : null);
  const chosen = src ?? text;
  return chosen.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

export function parseMeetingLink(raw: string): ParsedMeetingLink {
  const url = safeUrl(extractRecordingUrl(raw));
  if (!url) {
    return { provider: 'OTHER', embedUrl: null, mediaUrl: null, isJoinLink: false, label: 'Link', note: 'That does not look like a URL.' };
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  /**
   * A known provider always wins over the file extension. SharePoint and Drive links often end
   * in `.mp4`, but they are not fetchable media: they need the provider's own player and the
   * viewer's session. Feeding one to a <video> element gives a broken player, not a recording.
   */
  const knownHost =
    host.endsWith('.sharepoint.com') ||
    host === 'web.microsoftstream.com' ||
    host.endsWith('.svc.ms') ||
    host === 'drive.google.com' ||
    host === 'docs.google.com' ||
    host === 'meet.google.com' ||
    isHost(host, 'teams.microsoft.com') ||
    isHost(host, 'teams.live.com') ||
    isHost(host, 'zoom.us') ||
    isHost(host, 'zoom.com') ||
    isHost(host, 'zoomgov.com') ||
    isHost(host, 'dropbox.com');

  // Direct media file: play it ourselves.
  if (!knownHost && MEDIA_EXT.test(path)) {
    return { provider: 'FILE', embedUrl: null, mediaUrl: url.toString(), isJoinLink: false, label: 'Media file', note: null };
  }

  // Google Drive (Meet recordings) -> /preview embed.
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const byPath = /\/file\/d\/([^/]+)/.exec(path)?.[1];
    const byQuery = url.searchParams.get('id');
    const id = byPath ?? byQuery;
    if (id) {
      return { provider: 'DRIVE', embedUrl: `https://drive.google.com/file/d/${id}/preview`, mediaUrl: null, isJoinLink: false, label: 'Google Drive recording', note: null };
    }
    return { provider: 'DRIVE', embedUrl: null, mediaUrl: null, isJoinLink: false, label: 'Google Drive', note: 'Could not find a file id in that Drive link.' };
  }

  // Google Meet join link.
  if (host === 'meet.google.com') {
    return { provider: 'GOOGLE_MEET', embedUrl: null, mediaUrl: null, isJoinLink: true, label: 'Google Meet', note: 'This is a join link. Meet recordings land in Google Drive: paste the Drive link to play it here.' };
  }

  // SharePoint / OneDrive / Stream: where Teams recordings live. Only the player SharePoint
  // itself hands out for embedding (Share > Embed, a `_layouts/15/embed.aspx` link) can be framed.
  // A sharing link (`/:v:/s/...`), a `stream.aspx` page or a document-library path is the full
  // SharePoint page, which refuses to load inside another site - the browser shows "refused to
  // connect" and nothing else - so those open in a new tab and say what to paste instead.
  if (host.endsWith('.sharepoint.com') || host === 'web.microsoftstream.com' || host.endsWith('.svc.ms')) {
    const isStream = host === 'web.microsoftstream.com';
    const streamVideo = isStream ? /^\/(?:embed\/)?video\/([^/?#]+)/.exec(path)?.[1] : null;
    const embeddable = /\/_layouts\/15\/embed\.aspx/i.test(path) || Boolean(streamVideo);
    if (embeddable) {
      const embed = streamVideo ? new URL(`https://web.microsoftstream.com/embed/video/${streamVideo}`) : new URL(url.toString());
      if (streamVideo) embed.searchParams.set('autoplay', 'false');
      return {
        provider: 'SHAREPOINT',
        embedUrl: embed.toString(),
        mediaUrl: null,
        isJoinLink: false,
        label: isStream ? 'Microsoft Stream recording' : 'SharePoint / OneDrive recording',
        note: 'Viewers must be signed in to Microsoft 365 in this browser.',
      };
    }
    return {
      provider: 'SHAREPOINT',
      embedUrl: null,
      mediaUrl: null,
      isJoinLink: false,
      label: 'SharePoint / OneDrive recording',
      note: 'SharePoint refuses to show a sharing link inside another site. Open the video in SharePoint, choose Share > Embed, and paste that link to play it here.',
    };
  }

  // Teams: join links, or a recording redirect.
  if (isHost(host, 'teams.microsoft.com') || isHost(host, 'teams.live.com')) {
    const join = path.includes('/l/meetup-join') || path.includes('/l/meeting') || url.searchParams.has('meetingId');
    return {
      provider: 'TEAMS',
      embedUrl: null,
      mediaUrl: null,
      isJoinLink: join,
      label: 'Microsoft Teams',
      note: join
        ? 'This is a join link. Teams recordings are saved to SharePoint or OneDrive: paste that link to play it here.'
        : 'Teams pages cannot be embedded. Open the recording in SharePoint or OneDrive and paste that link instead.',
    };
  }

  // Zoom: cloud recordings and join links both refuse framing.
  if (isHost(host, 'zoom.us') || isHost(host, 'zoom.com') || isHost(host, 'zoomgov.com')) {
    const rec = path.includes('/rec/');
    return {
      provider: 'ZOOM',
      embedUrl: null,
      mediaUrl: null,
      isJoinLink: !rec,
      label: rec ? 'Zoom cloud recording' : 'Zoom meeting',
      note: rec
        ? 'Zoom blocks embedding its recording player, so this opens in a new tab. Download the mp4 and host it somewhere to play it inline.'
        : 'This is a join link, not a recording.',
    };
  }

  // Services whose share link turns into their own player link with nothing signed in.
  const player = playerFor(url, host, path);
  if (player) return { provider: 'OTHER', embedUrl: player.embedUrl, mediaUrl: player.mediaUrl ?? null, isJoinLink: false, label: player.label, note: null };

  // Anything else: try an iframe only if it is same-scheme https; most sites refuse, and the UI
  // shows a fallback link if the frame stays blank.
  return { provider: 'OTHER', embedUrl: null, mediaUrl: null, isJoinLink: false, label: host, note: 'Unknown provider: Cadence will link out rather than embed.' };
}

/**
 * The player link behind a share link, for the services that hand one out to anyone with the link:
 * YouTube, Vimeo, Loom and Fathom play in a frame, and a Dropbox file plays as the file itself.
 */
function playerFor(url: URL, host: string, path: string): { embedUrl: string | null; mediaUrl?: string; label: string } | null {
  if (isHost(host, 'youtube.com') || host === 'youtu.be' || isHost(host, 'youtube-nocookie.com')) {
    const id = host === 'youtu.be' ? path.slice(1).split('/')[0] : url.searchParams.get('v') ?? /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(path)?.[1];
    return id ? { embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(id)}`, label: 'YouTube' } : null;
  }
  if (isHost(host, 'vimeo.com')) {
    const m = /^\/(?:video\/)?(\d+)(?:\/([0-9a-f]+))?/.exec(path);
    if (!m) return null;
    const hash = m[2] ?? url.searchParams.get('h');
    return { embedUrl: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ''}`, label: 'Vimeo' };
  }
  if (isHost(host, 'loom.com')) {
    const id = /^\/(?:share|embed)\/([0-9a-z]+)/i.exec(path)?.[1];
    return id ? { embedUrl: `https://www.loom.com/embed/${id}`, label: 'Loom' } : null;
  }
  if (isHost(host, 'fathom.video')) {
    const id = /^\/(?:share|embed)\/([^/?#]+)/.exec(path)?.[1];
    return id ? { embedUrl: `https://fathom.video/embed/${id}`, label: 'Fathom' } : null;
  }
  if (isHost(host, 'dropbox.com') && MEDIA_EXT.test(path)) {
    const file = new URL(url.toString());
    file.searchParams.delete('dl');
    file.searchParams.set('raw', '1');
    return { embedUrl: null, mediaUrl: file.toString(), label: 'Dropbox' };
  }
  return null;
}

export const PROVIDER_LABELS: Record<MeetingProvider, string> = {
  TEAMS: 'Teams',
  ZOOM: 'Zoom',
  GOOGLE_MEET: 'Google Meet',
  SHAREPOINT: 'SharePoint',
  DRIVE: 'Drive',
  FILE: 'Uploaded file',
  OTHER: 'Other link',
};

/** What a meeting's link is, for the list and the meeting page: the service by name, not "Other link". */
export function platformLabel(provider: MeetingProvider, sourceUrl: string): string {
  if (provider !== 'OTHER' && provider !== 'FILE') return PROVIDER_LABELS[provider];
  if (!sourceUrl) return 'No link';
  const parsed = parseMeetingLink(sourceUrl);
  return parsed.provider === 'FILE' ? 'Media file' : parsed.label;
}

/** Guess a provider for the meeting itself (not the recording) from any of its links. */
export function providerFromAny(links: string[]): MeetingProvider {
  for (const l of links) {
    const p = parseMeetingLink(l).provider;
    if (p !== 'OTHER' && p !== 'FILE') return p;
  }
  return 'OTHER';
}
