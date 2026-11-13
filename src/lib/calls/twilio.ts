import { env } from '../env';
import { getFakeTwilio } from './fake-twilio';

/**
 * Twilio, read only (decisions 4 and 5 of docs/outreach-sandbox-plan.md). Calls go through the
 * existing hosted dialpad; Cadence reads them, their recordings and the account's numbers from the
 * REST API with a Restricted API key, and never writes to Twilio. No twilio package: plain fetch.
 */

export type TwilioCall = {
  sid: string;
  parentCallSid: string | null;
  from: string;
  to: string;
  /** queued | initiated | ringing | in-progress | completed | busy | no-answer | failed | canceled */
  status: string;
  /** inbound | outbound-api | outbound-dial */
  direction: string;
  startTime: string | null;
  endTime: string | null;
  durationSec: number | null;
  /** Negative, as Twilio reports cost; Cadence stores the amount. */
  price: number | null;
};
export type TwilioRecording = { sid: string; callSid: string; durationSec: number | null; status: string; dateCreated: string | null };
export type TwilioNumber = { sid: string; phoneNumber: string; friendlyName: string };

export interface TwilioReader {
  readonly kind: 'rest' | 'fake';
  /** Calls that started after `after` (and before `before`, when given), a page at a time (follow nextPage). */
  listCalls(opts: { after: Date; before?: Date | null; nextPage?: string | null }): Promise<{ calls: TwilioCall[]; nextPage: string | null }>;
  getCall(sid: string): Promise<TwilioCall | null>;
  listRecordings(callSid: string): Promise<TwilioRecording[]>;
  listNumbers(): Promise<TwilioNumber[]>;
  /** The recording's audio, streamed; `range` passes through so seeking works. */
  recordingMedia(recordingSid: string, range: string | null): Promise<Response>;
}

type Raw = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? null : String(v));
const n = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const when = (v: unknown) => { const t = s(v); if (!t) return null; const d = new Date(t); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

export const callFromRaw = (r: Raw): TwilioCall => ({
  sid: String(r.sid), parentCallSid: s(r.parent_call_sid), from: s(r.from) ?? '', to: s(r.to) ?? '', status: s(r.status) ?? 'queued', direction: s(r.direction) ?? 'outbound-api',
  startTime: when(r.start_time), endTime: when(r.end_time), durationSec: n(r.duration),
  // M49: Cadence stores cost in US dollars, so a price billed in another currency is not stored as one.
  price: r.price_unit && String(r.price_unit).toUpperCase() !== 'USD' ? null : n(r.price),
});

/** M27: how long to wait before asking again after a 429 or 5xx (Twilio's Retry-After, at most 5 seconds). */
const retryWaitMs = (res: Response, attempt: number) => {
  const after = Number(res.headers.get('retry-after'));
  return Math.min(Number.isFinite(after) && after >= 0 && res.headers.has('retry-after') ? after * 1000 : 1000 * (attempt + 1), 5000);
};
const recordingFromRaw = (r: Raw): TwilioRecording => ({ sid: String(r.sid), callSid: s(r.call_sid) ?? '', durationSec: n(r.duration), status: s(r.status) ?? 'completed', dateCreated: when(r.date_created) });

export class TwilioRestReader implements TwilioReader {
  readonly kind = 'rest' as const;
  constructor(private readonly cfg: { accountSid: string; keySid: string; keySecret: string; baseUrl: string; fetchImpl?: typeof fetch }) {}

  private get auth() { return `Basic ${Buffer.from(`${this.cfg.keySid}:${this.cfg.keySecret}`).toString('base64')}`; }
  private url(path: string) { return `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`; }
  private account(path: string) { return `/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}${path}`; }

  /** `list`: a 404 on a list means the account or key is wrong, never "nothing there" (M20). */
  private async get(pathOrUri: string, list = false): Promise<Raw> {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await (this.cfg.fetchImpl ?? fetch)(this.url(pathOrUri), { headers: { authorization: this.auth, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      // M27: a 429 or 5xx is asked again, twice at most, after Twilio's wait, instead of stopping the run.
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { const wait = retryWaitMs(res, attempt); await res.text().catch(() => ''); await new Promise((r) => setTimeout(r, wait)); continue; }
      break;
    }
    if (res.status === 404 && !list) return {};
    if (res.status === 404) throw new Error('Twilio answered 404 to the list of calls (check TWILIO_ACCOUNT_SID).');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Twilio answered ${res.status}${res.status === 401 || res.status === 403 ? ' (check TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, and that the key may read calls)' : ''}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as Raw;
  }

  async listCalls(opts: { after: Date; before?: Date | null; nextPage?: string | null }) {
    const path = opts.nextPage ?? `${this.account('/Calls.json')}?${new URLSearchParams({ 'StartTime>': opts.after.toISOString(), ...(opts.before ? { 'StartTime<': opts.before.toISOString() } : {}), PageSize: '100' }).toString()}`;
    const data = await this.get(path, true);
    const calls = Array.isArray(data.calls) ? (data.calls as Raw[]).map(callFromRaw) : [];
    return { calls, nextPage: s(data.next_page_uri) };
  }

  async getCall(sid: string) {
    const data = await this.get(this.account(`/Calls/${encodeURIComponent(sid)}.json`));
    return data.sid ? callFromRaw(data) : null;
  }

  async listRecordings(callSid: string) {
    const data = await this.get(this.account(`/Calls/${encodeURIComponent(callSid)}/Recordings.json`));
    return Array.isArray(data.recordings) ? (data.recordings as Raw[]).map(recordingFromRaw) : [];
  }

  async listNumbers() {
    const out: TwilioNumber[] = [];
    let path: string | null = `${this.account('/IncomingPhoneNumbers.json')}?PageSize=200`;
    for (let i = 0; path && i < 20; i++) {
      const data: Raw = await this.get(path, true);
      for (const r of (Array.isArray(data.incoming_phone_numbers) ? data.incoming_phone_numbers : []) as Raw[]) out.push({ sid: String(r.sid), phoneNumber: s(r.phone_number) ?? '', friendlyName: s(r.friendly_name) ?? '' });
      path = s(data.next_page_uri);
    }
    return out;
  }

  async recordingMedia(recordingSid: string, range: string | null) {
    const headers: Record<string, string> = { authorization: this.auth };
    if (range) headers.range = range;
    // M48: the time limit covers Twilio's answer, not the download, so a long recording is never cut off.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      return await (this.cfg.fetchImpl ?? fetch)(this.url(this.account(`/Recordings/${encodeURIComponent(recordingSid)}.mp3`)), { headers, signal: abort.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Whether the import has what it needs, and what is missing in plain words. */
export function twilioStatus(): { configured: boolean; fake: boolean; missing: string[] } {
  const e = env();
  if (fakeTwilioOn()) return { configured: true, fake: true, missing: [] };
  const missing = [['TWILIO_ACCOUNT_SID', e.TWILIO_ACCOUNT_SID], ['TWILIO_API_KEY_SID', e.TWILIO_API_KEY_SID], ['TWILIO_API_KEY_SECRET', e.TWILIO_API_KEY_SECRET]].filter(([, v]) => !v).map(([k]) => k as string);
  return { configured: missing.length === 0, fake: false, missing };
}

function fakeTwilioOn(): boolean {
  const e = env();
  if (e.CADENCE_FAKE_TWILIO !== '1') return false;
  // The stand-in serves the test suites and the local launcher only, like the mock CRM.
  // M22: whatever NODE_ENV says, and never in place of a real Twilio account that is configured.
  if (e.CADENCE_ALLOW_MOCK !== '1') throw new Error('CADENCE_FAKE_TWILIO=1 needs CADENCE_ALLOW_MOCK=1. Unset it and set the TWILIO_* variables.');
  if (e.TWILIO_ACCOUNT_SID || e.TWILIO_API_KEY_SID || e.TWILIO_API_KEY_SECRET) throw new Error('CADENCE_FAKE_TWILIO=1 is set alongside real TWILIO_* keys. Unset CADENCE_FAKE_TWILIO so the real account is read.');
  return true;
}

/** The reader to use now: the stand-in in tests, the REST API when configured, else none (import off). */
export function getTwilioReader(): TwilioReader | null {
  if (fakeTwilioOn()) return getFakeTwilio();
  const e = env();
  if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_API_KEY_SID || !e.TWILIO_API_KEY_SECRET) return null;
  return new TwilioRestReader({ accountSid: e.TWILIO_ACCOUNT_SID, keySid: e.TWILIO_API_KEY_SID, keySecret: e.TWILIO_API_KEY_SECRET, baseUrl: e.TWILIO_API_URL });
}
