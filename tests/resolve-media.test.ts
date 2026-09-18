import { describe, expect, it } from 'vitest';
import { candidateMediaUrls, dateInText, inspectLink, resolveDirectMedia } from '@/lib/meetings/resolve-media';

const fakeFetch = (routes: Record<string, { status?: number; type: string; body?: string; finalUrl?: string }>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!hit) return new Response('not found', { status: 404 });
    const res = new Response(hit.body ?? '', { status: hit.status ?? 200, headers: { 'content-type': hit.type } });
    Object.defineProperty(res, 'url', { value: hit.finalUrl ?? url });
    return res;
  }) as typeof fetch;

describe('direct media behind a sharing link', () => {
  it('asks SharePoint for the download and Drive for the file, and never a private address', () => {
    expect(candidateMediaUrls('https://acme.sharepoint.com/:v:/s/sales/abc?e=xyz')[0]).toBe('https://acme.sharepoint.com/:v:/s/sales/abc?e=xyz&download=1');
    expect(candidateMediaUrls('https://drive.google.com/file/d/FILE123/view?usp=sharing')[0]).toBe('https://drive.google.com/uc?export=download&id=FILE123');
    expect(candidateMediaUrls('http://localhost:3000/x')).toEqual([]);
    expect(candidateMediaUrls('http://192.168.1.10/recording.mp4')).toEqual([]);
  });

  it('keeps the address only when the answer is video or audio', async () => {
    const yes = fakeFetch({ 'https://acme.sharepoint.com/': { status: 206, type: 'video/mp4', finalUrl: 'https://acme.sharepoint.com/download/recording.mp4' } });
    expect(await resolveDirectMedia('https://acme.sharepoint.com/:v:/s/sales/abc', yes)).toBe('https://acme.sharepoint.com/download/recording.mp4');
    const wall = fakeFetch({ 'https://acme.sharepoint.com/': { status: 200, type: 'text/html; charset=utf-8', body: '<html>sign in</html>' } });
    expect(await resolveDirectMedia('https://acme.sharepoint.com/:v:/s/sales/abc', wall)).toBeNull();
    expect(await resolveDirectMedia('https://teams.microsoft.com/l/meetup-join/abc', yes)).toBeNull();
    expect(await resolveDirectMedia('https://cdn.example.com/call.mp4', wall)).toBe('https://cdn.example.com/call.mp4');
  });
});

describe('what a link says about itself', () => {
  it('reads a date written any of the usual ways', () => {
    expect(dateInText('Acubooth <> Alisa - 12 Sep 2026')).toBe('2026-09-12');
    expect(dateInText('Recording from September 12th, 2026')).toBe('2026-09-12');
    expect(dateInText('Weekly sync 2026-09-12 notes')).toBe('2026-09-12');
    expect(dateInText('call 9/12/2026')).toBe('2026-09-12');
    expect(dateInText('call 25/09/2026')).toBe('2026-09-25');
    expect(dateInText('no date here')).toBeNull();
  });

  it('takes the page title, description and date, and a direct media address when the page names one', async () => {
    const html = '<html><head><title>Acubooth Meeting with Alisa - 12 Sep 2026 | Microsoft Stream</title><meta property="og:description" content="Discovery call with Acubooth"><meta property="og:video" content="https://cdn.example.com/rec.mp4"></head></html>';
    const fetchImpl = fakeFetch({ 'https://acme.sharepoint.com/': { type: 'text/html', body: html } });
    const page = await inspectLink('https://acme.sharepoint.com/:v:/s/sales/abc', fetchImpl);
    expect(page.title).toContain('Acubooth Meeting with Alisa');
    expect(page.description).toBe('Discovery call with Acubooth');
    expect(page.date).toBe('2026-09-12');
    expect(page.mediaUrl).toBe('https://cdn.example.com/rec.mp4');
  });

  it('a page that cannot be read leaves every field empty rather than guessing', async () => {
    const fetchImpl = fakeFetch({});
    const page = await inspectLink('https://example.com/private', fetchImpl);
    expect(page).toEqual({ title: null, description: null, date: null, mediaUrl: null });
  });
});
