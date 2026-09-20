import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(address, prefix, 'ipv6');
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return true;
  const family = isIP(h);
  return Boolean(family && blocked.check(h, family === 6 ? 'ipv6' : 'ipv4'));
}

/** Pinned DNS address, no automatic redirects, bounded body. Used only for public link metadata. */
export async function publicLinkFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || isPrivateHost(host)) throw new Error('Only public web links can be inspected.');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(row => isPrivateHost(row.address))) throw new Error('Private network links cannot be inspected.');
  init?.signal?.throwIfAborted();
  const headers = Object.fromEntries(new Headers(init?.headers));
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requester(url, { hostname: addresses[0].address, servername: host, method: 'GET', agent: false, headers: { ...headers, host: url.host, 'accept-encoding': 'identity' }, signal: init?.signal ?? undefined }, res => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      const chunks: Buffer[] = []; let bytes = 0;
      const finish = () => {
        const status = res.statusCode ?? 502;
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks).toString('utf8');
        const response = new Response(body, { status, headers: responseHeaders });
        Object.defineProperty(response, 'url', { value: url.toString() });
        resolve(response);
      };
      // A probe needs headers only. Never download an entire customer recording to inspect it.
      if (headers.range || (res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 || /^(audio|video)\//i.test(responseHeaders.get('content-type') ?? '')) { finish(); res.destroy(); return; }
      res.on('data', (chunk: Buffer) => {
        const part = Buffer.from(chunk).subarray(0, 300_000 - bytes); chunks.push(part); bytes += part.length;
        if (bytes >= 300_000) { finish(); res.destroy(); }
      });
      res.on('end', finish); res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

/** Every redirect is checked before requesting the next hop. */
export async function fetchPublicRedirects(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  for (let hop = 0; hop < 6; hop++) {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || target.username || target.password || isPrivateHost(target.hostname)) throw new Error('Only public web links can be inspected.');
    const response = await fetchImpl(url, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) return response;
    url = new URL(location, url).toString();
  }
  throw new Error('Too many redirects.');
}
