import { describe, expect, it } from 'vitest';
import { extractRecordingUrl, parseMeetingLink, providerFromAny } from '@/lib/meetings/providers';

describe('parseMeetingLink', () => {
  it('plays a direct media file inline', () => {
    const r = parseMeetingLink('https://files.example.com/recordings/call.mp4?token=abc');
    expect(r.provider).toBe('FILE');
    expect(r.mediaUrl).toBe('https://files.example.com/recordings/call.mp4?token=abc');
    expect(r.embedUrl).toBeNull();
    expect(r.note).toBeNull();
  });

  it('frames the embed player SharePoint hands out, where Teams recordings land', () => {
    const r = parseMeetingLink('https://acme.sharepoint.com/sites/rec/_layouts/15/embed.aspx?UniqueId=7f3a&embed=%7B%22af%22%3Atrue%7D');
    expect(r.provider).toBe('SHAREPOINT');
    expect(r.embedUrl).toContain('/_layouts/15/embed.aspx');
    expect(r.embedUrl).toContain('UniqueId=7f3a');
    expect(r.isJoinLink).toBe(false);
    const stream = parseMeetingLink('https://web.microsoftstream.com/video/0a1b-2c3d');
    expect(stream.embedUrl).toBe('https://web.microsoftstream.com/embed/video/0a1b-2c3d?autoplay=false');
  });

  it('links out for a SharePoint sharing link, which refuses to be framed, and says what to paste', () => {
    // The live workspace pasted a "/:v:/s/" sharing link and the frame read "refused to connect".
    for (const link of [
      'https://glynac.sharepoint.com/:v:/s/Sales/EaBcDeFgHiJkLmNoP?e=4%3Axyz',
      'https://acme.sharepoint.com/sites/rec/Shared%20Documents/call.mp4',
      'https://acme-my.sharepoint.com/personal/x_acme_com/_layouts/15/stream.aspx?id=%2Fpersonal%2Fcall.mp4',
    ]) {
      const r = parseMeetingLink(link);
      expect(r.provider).toBe('SHAREPOINT');
      expect(r.embedUrl).toBeNull();
      expect(r.mediaUrl).toBeNull(); // needs the viewer's Microsoft session; a <video> element would just break
      expect(r.isJoinLink).toBe(false);
      expect(r.note).toMatch(/Share > Embed/);
    }
    const drive = parseMeetingLink('https://drive.google.com/file/d/abc/view/recording.mp4');
    expect(drive.provider).toBe('DRIVE');
    expect(drive.mediaUrl).toBeNull();
    const zoom = parseMeetingLink('https://acme.zoom.us/rec/download/thing.mp4');
    expect(zoom.provider).toBe('ZOOM');
    expect(zoom.mediaUrl).toBeNull();
  });

  it('takes the src out of a pasted Share > Embed code, entities and all', () => {
    const pasted = '<iframe src="https://glynac-my.sharepoint.com/personal/alisa_acumen-strategy_com/_layouts/15/embed.aspx?UniqueId=88a4d11b-3f06-4bff-a726-8576be121d20&amp;embed=%7B%22ust%22%3Afalse%7D&amp;referrer=StreamWebApp" width="640" height="360" frameborder="0" scrolling="no" allowfullscreen title="Alisa and Lloyd-20260811 Meeting Recording.mp4"></iframe>';
    const url = extractRecordingUrl(pasted);
    expect(url).toBe('https://glynac-my.sharepoint.com/personal/alisa_acumen-strategy_com/_layouts/15/embed.aspx?UniqueId=88a4d11b-3f06-4bff-a726-8576be121d20&embed=%7B%22ust%22%3Afalse%7D&referrer=StreamWebApp');
    const r = parseMeetingLink(pasted);
    expect(r.provider).toBe('SHAREPOINT');
    expect(r.embedUrl).toContain('/_layouts/15/embed.aspx?UniqueId=88a4d11b');
    expect(extractRecordingUrl('  https://acme.zoom.us/rec/share/abc ')).toBe('https://acme.zoom.us/rec/share/abc');
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
