import type { MeetingProvider } from '@prisma/client';

/**
 * Turn a pasted recording link into something the app can play.
 *
 * Reality check on embedding, because it decides what the UI can do:
 *  - **SharePoint / Microsoft Stream** (where Teams recordings land) supports iframe embedding.
 *    Adding `&embed=true` (or using the "Embed" code from the file) renders their player. The
 *    viewer must be signed in to Microsoft 365 in the same browser.
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

const MEDIA_EXT = /\.(mp4|webm|m4v|ogv|ogg|mov)(\?|#|$)/i;
const isHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function parseMeetingLink(raw: string): ParsedMeetingLink {
  const url = safeUrl(raw);
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
    isHost(host, 'zoomgov.com');

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

  // SharePoint / OneDrive / Stream: where Teams recordings live. Framing is allowed.
  if (host.endsWith('.sharepoint.com') || host.endsWith('-my.sharepoint.com') || host === 'web.microsoftstream.com' || host.endsWith('.svc.ms')) {
    const embed = new URL(url.toString());
    // The SharePoint player honours these; harmless when already present.
    if (!embed.searchParams.has('embed')) embed.searchParams.set('embed', 'true');
    embed.searchParams.set('nav', 'false');
    const isStream = host === 'web.microsoftstream.com';
    return {
      provider: isStream ? 'SHAREPOINT' : 'SHAREPOINT',
      embedUrl: embed.toString(),
      mediaUrl: null,
      isJoinLink: false,
      label: isStream ? 'Microsoft Stream recording' : 'SharePoint / OneDrive recording',
      note: 'Viewers must be signed in to Microsoft 365 in this browser.',
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

  // Anything else: try an iframe only if it is same-scheme https; most sites refuse, and the UI
  // shows a fallback link if the frame stays blank.
  return { provider: 'OTHER', embedUrl: null, mediaUrl: null, isJoinLink: false, label: host, note: 'Unknown provider: Cadence will link out rather than embed.' };
}

export const PROVIDER_LABELS: Record<MeetingProvider, string> = {
  TEAMS: 'Teams',
  ZOOM: 'Zoom',
  GOOGLE_MEET: 'Google Meet',
  SHAREPOINT: 'SharePoint',
  DRIVE: 'Drive',
  FILE: 'File',
  OTHER: 'Link',
};

/** Guess a provider for the meeting itself (not the recording) from any of its links. */
export function providerFromAny(links: string[]): MeetingProvider {
  for (const l of links) {
    const p = parseMeetingLink(l).provider;
    if (p !== 'OTHER' && p !== 'FILE') return p;
  }
  return 'OTHER';
}
