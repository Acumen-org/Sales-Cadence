import { describe, expect, it } from 'vitest';
import { parseMeetingLink, providerFromAny } from '@/lib/meetings/providers';

describe('parseMeetingLink', () => {
  it('plays a direct media file inline', () => {
    const r = parseMeetingLink('https://files.example.com/recordings/call.mp4?token=abc');
    expect(r.provider).toBe('FILE');
    expect(r.mediaUrl).toBe('https://files.example.com/recordings/call.mp4?token=abc');
    expect(r.embedUrl).toBeNull();
    expect(r.note).toBeNull();
  });

  it('frames a SharePoint recording, where Teams recordings land', () => {
    const r = parseMeetingLink('https://acme.sharepoint.com/sites/rec/Shared%20Documents/call.mp4x');
    expect(r.provider).toBe('SHAREPOINT');
    expect(r.embedUrl).toContain('embed=true');
    expect(r.embedUrl).toContain('nav=false');
    expect(r.isJoinLink).toBe(false);
  });

  it('uses the provider player for a SharePoint or Drive link that ends in .mp4', () => {
    // These need the viewer's Microsoft or Google session; a <video> element would just break.
    const sp = parseMeetingLink('https://acme.sharepoint.com/sites/rec/Shared%20Documents/call.mp4');
    expect(sp.provider).toBe('SHAREPOINT');
    expect(sp.mediaUrl).toBeNull();
    expect(sp.embedUrl).toContain('embed=true');
    const drive = parseMeetingLink('https://drive.google.com/file/d/abc/view/recording.mp4');
    expect(drive.provider).toBe('DRIVE');
    expect(drive.mediaUrl).toBeNull();
    const zoom = parseMeetingLink('https://acme.zoom.us/rec/download/thing.mp4');
    expect(zoom.provider).toBe('ZOOM');
    expect(zoom.mediaUrl).toBeNull();
  });

  it('does not add embed=true twice', () => {
    const r = parseMeetingLink('https://acme.sharepoint.com/x/y?embed=true');
    expect(r.embedUrl!.match(/embed=true/g)).toHaveLength(1);
  });

  it('turns a Drive share link into a preview embed', () => {
    const r = parseMeetingLink('https://drive.google.com/file/d/1AbCdEf/view?usp=sharing');
    expect(r.provider).toBe('DRIVE');
    expect(r.embedUrl).toBe('https://drive.google.com/file/d/1AbCdEf/preview');
  });

  it('reads a Drive id from the query form too', () => {
    expect(parseMeetingLink('https://drive.google.com/open?id=XYZ123').embedUrl).toBe('https://drive.google.com/file/d/XYZ123/preview');
  });

  it('treats a Meet link as a join, not a recording', () => {
    const r = parseMeetingLink('https://meet.google.com/abc-defg-hij');
    expect(r.provider).toBe('GOOGLE_MEET');
    expect(r.isJoinLink).toBe(true);
    expect(r.embedUrl).toBeNull();
    expect(r.note).toMatch(/Drive/);
  });

  it('recognises a Teams join link and says where the recording is', () => {
    const r = parseMeetingLink('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0');
    expect(r.provider).toBe('TEAMS');
    expect(r.isJoinLink).toBe(true);
    expect(r.note).toMatch(/SharePoint|OneDrive/);
  });

  it('links out for a Zoom cloud recording, because Zoom refuses framing', () => {
    const r = parseMeetingLink('https://acme.zoom.us/rec/share/abc123');
    expect(r.provider).toBe('ZOOM');
    expect(r.embedUrl).toBeNull();
    expect(r.isJoinLink).toBe(false);
    expect(r.note).toMatch(/embedding/i);
  });

  it('marks a Zoom join link as a join', () => {
    expect(parseMeetingLink('https://zoom.us/j/9876543210').isJoinLink).toBe(true);
  });

  it('rejects text that is not a URL, and non-web schemes', () => {
    expect(parseMeetingLink('tomorrow at 3').note).toMatch(/does not look like a URL/);
    expect(parseMeetingLink('javascript:alert(1)').provider).toBe('OTHER');
    expect(parseMeetingLink('javascript:alert(1)').embedUrl).toBeNull();
    expect(parseMeetingLink('file:///c:/secret.mp4').mediaUrl).toBeNull();
  });

  it('falls back to a link-out for unknown hosts', () => {
    const r = parseMeetingLink('https://recordings.internal.example/watch/42');
    expect(r.provider).toBe('OTHER');
    expect(r.embedUrl).toBeNull();
    expect(r.label).toBe('recordings.internal.example');
  });

  it('picks the meeting provider from a set of links, ignoring files', () => {
    expect(providerFromAny(['https://x.example/a.mp4', 'https://acme.zoom.us/j/1'])).toBe('ZOOM');
    expect(providerFromAny(['https://x.example/a.mp4'])).toBe('OTHER');
  });
});
