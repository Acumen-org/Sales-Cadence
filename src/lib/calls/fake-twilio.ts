import type { TwilioCall, TwilioNumber, TwilioReader, TwilioRecording } from './twilio';

/**
 * An in-memory Twilio with the reader's interface, for the test suites and the local launcher
 * (CADENCE_FAKE_TWILIO=1). Shared through globalThis so a test route and the import see one account.
 */
export class FakeTwilio implements TwilioReader {
  readonly kind = 'fake' as const;
  calls: TwilioCall[] = [];
  recordings: TwilioRecording[] = [];
  numbers: TwilioNumber[] = [];
  /** Calls per page, small so paging is exercised. */
  pageSize = 2;
  requests: string[] = [];
  private seq = 0;

  reset() { this.calls = []; this.recordings = []; this.numbers = []; this.requests = []; this.seq = 0; this.pageSize = 2; }

  nextSid(prefix: 'CA' | 'RE' | 'PN') { this.seq += 1; return `${prefix}${String(this.seq).padStart(32, '0')}`; }

  addCall(input: Partial<TwilioCall> & Pick<TwilioCall, 'from' | 'to'>): TwilioCall {
    const now = new Date();
    const call: TwilioCall = {
      sid: input.sid ?? this.nextSid('CA'), parentCallSid: input.parentCallSid ?? null, from: input.from, to: input.to, status: input.status ?? 'completed',
      direction: input.direction ?? 'outbound-dial', startTime: input.startTime ?? new Date(now.getTime() - 5 * 60_000).toISOString(),
      endTime: input.endTime ?? (input.status && !['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(input.status) ? null : now.toISOString()),
      durationSec: input.durationSec ?? 95, price: input.price ?? -0.021,
    };
    this.calls.push(call);
    return call;
  }

  updateCall(sid: string, patch: Partial<TwilioCall>) { const c = this.calls.find((x) => x.sid === sid); if (c) Object.assign(c, patch); return c; }

  addRecording(callSid: string, durationSec = 90): TwilioRecording {
    const r: TwilioRecording = { sid: this.nextSid('RE'), callSid, durationSec, status: 'completed', dateCreated: new Date().toISOString() };
    this.recordings.push(r);
    return r;
  }

  addNumber(phoneNumber: string, friendlyName: string): TwilioNumber {
    const n: TwilioNumber = { sid: this.nextSid('PN'), phoneNumber, friendlyName };
    this.numbers.push(n);
    return n;
  }

  async listCalls(opts: { after: Date; nextPage?: string | null }) {
    this.requests.push(`calls:${opts.after.toISOString()}:${opts.nextPage ?? ''}`);
    const all = this.calls.filter((c) => c.startTime && new Date(c.startTime) > opts.after).sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
    const offset = opts.nextPage ? Number(opts.nextPage) : 0;
    const page = all.slice(offset, offset + this.pageSize);
    return { calls: JSON.parse(JSON.stringify(page)) as TwilioCall[], nextPage: offset + this.pageSize < all.length ? String(offset + this.pageSize) : null };
  }

  async getCall(sid: string) { this.requests.push(`call:${sid}`); const c = this.calls.find((x) => x.sid === sid); return c ? { ...c } : null; }
  async listRecordings(callSid: string) { this.requests.push(`recordings:${callSid}`); return this.recordings.filter((r) => r.callSid === callSid).map((r) => ({ ...r })); }
  async listNumbers() { return this.numbers.map((n) => ({ ...n })); }

  async recordingMedia(recordingSid: string, range: string | null) {
    if (!this.recordings.some((r) => r.sid === recordingSid)) return new Response('Not found', { status: 404 });
    // A second of silence as an MPEG frame sequence is not needed for the tests: the bytes say which recording it is.
    const body = new TextEncoder().encode(`fake-recording:${recordingSid}`);
    if (range) return new Response(body.slice(0, 8), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-7/${body.length}`, 'accept-ranges': 'bytes' } });
    return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(body.length), 'accept-ranges': 'bytes' } });
  }
}

const g = globalThis as unknown as { __cadenceFakeTwilio?: FakeTwilio };
export function getFakeTwilio(): FakeTwilio {
  if (!g.__cadenceFakeTwilio) g.__cadenceFakeTwilio = new FakeTwilio();
  return g.__cadenceFakeTwilio;
}
