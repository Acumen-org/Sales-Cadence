import { z } from 'zod';
import { prisma } from '../db';
import { env } from '../env';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { toE164 } from '../sandbox/normalize';

/**
 * Which rep has which Twilio number comes from h00ks, where admins assign them in the dialpad admin
 * (owner, 12 Nov 2026). Before each call import Cadence reads h00ks's partner API (`staff:read`) and
 * copies each rep's number and dialpad identity onto the Cadence user with the same email. h00ks is
 * the only place numbers are assigned: Settings > Calling shows them.
 */

const STATUS_KEY = 'h00ksNumberSync';

const StaffSchema = z.object({
  mode: z.string().optional(),
  data: z.array(z.object({
    id: z.string(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    resigned: z.boolean().nullish(),
    clientIdentity: z.string().nullish(),
    numbers: z.array(z.string()).nullish(),
  }).passthrough()),
});

export type H00ksStaff = { id: string; name: string | null; email: string | null; resigned: boolean; clientIdentity: string | null; numbers: string[] };
/** Someone h00ks gives a number to whose email is not a Cadence user's: an admin fixes the email in one of the two. */
export type H00ksUnmatched = { name: string | null; email: string | null; number: string };
export type NumberChange = { userId: string; name: string; from: string | null; to: string | null };
export type NumberSyncResult = { ran: boolean; reason?: string; error?: string; changed: NumberChange[]; identitiesAdded: number; unmatched: H00ksUnmatched[] };

/** Whether numbers come from h00ks (H00KS_API_TOKEN set). */
export function h00ksConfigured(): boolean {
  return Boolean(env().H00KS_API_TOKEN);
}

/** GET /staff on h00ks's partner API. A test key, an error answer or an empty list throws: nothing is changed then. */
export async function fetchH00ksStaff(opts: { token?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<H00ksStaff[]> {
  const token = opts.token ?? env().H00KS_API_TOKEN;
  if (!token) throw new Error('H00KS_API_TOKEN is not set.');
  const base = (opts.baseUrl ?? env().H00KS_API_URL).replace(/\/+$/, '');
  const res = await (opts.fetchImpl ?? fetch)(`${base}/staff`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`h00ks answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const parsed = StaffSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('h00ks sent a staff list Cadence cannot read.');
  if (parsed.data.mode && parsed.data.mode !== 'live') throw new Error(`The h00ks key is a ${parsed.data.mode} key: make a Live one with staff:read.`);
  if (!parsed.data.data.length) throw new Error('h00ks sent an empty staff list.');
  return parsed.data.data.map((s) => ({ id: s.id, name: s.name ?? null, email: s.email ?? null, resigned: Boolean(s.resigned), clientIdentity: s.clientIdentity?.trim() || null, numbers: s.numbers ?? [] }));
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Makes Cadence's numbers what h00ks says. Each active user gets the number h00ks gives the staff
 * member with their email (none when resigned or unassigned); everyone else, removed users included,
 * holds none. A changed number counts from now, so earlier calls on it keep their rep (B165). The
 * dialpad identity is added to the user's aliases, which match calls made from the browser.
 */
export async function applyH00ksNumbers(staff: H00ksStaff[], now = new Date()): Promise<Omit<NumberSyncResult, 'ran'>> {
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true, active: true, callerNumber: true, aliases: true } });
  const byEmail = new Map(users.map((u) => [lower(u.email), u]));
  const want = new Map<string, string | null>(users.map((u) => [u.id, null]));
  const identity = new Map<string, string>();
  const taken = new Set<string>();
  const unmatched: H00ksUnmatched[] = [];
  for (const s of staff) {
    const number = s.resigned ? null : s.numbers.map((n) => toE164(n)).find((n): n is string => Boolean(n)) ?? null;
    const user = s.email ? byEmail.get(lower(s.email)) : undefined;
    if (!user) {
      if (number) unmatched.push({ name: s.name, email: s.email, number });
      continue;
    }
    if (s.clientIdentity) identity.set(user.id, s.clientIdentity.toLowerCase());
    // h00ks gives a number to one person; a second claim on it is ignored rather than guessed at.
    if (user.active && number && !taken.has(number)) { want.set(user.id, number); taken.add(number); }
  }
  const changed: NumberChange[] = users.filter((u) => (u.callerNumber ?? null) !== want.get(u.id)).map((u) => ({ userId: u.id, name: u.name, from: u.callerNumber ?? null, to: want.get(u.id) ?? null }));
  const aliasAdds = users.flatMap((u) => {
    const id = identity.get(u.id);
    return id && !u.aliases.some((a) => lower(a) === id) ? [{ id: u.id, aliases: [...u.aliases, id] }] : [];
  });
  if (changed.length || aliasAdds.length) {
    await prisma.$transaction(async (tx) => {
      // Numbers are unique: everyone losing or changing theirs lets go first, then the new ones are set.
      for (const c of changed) if (c.from) await tx.user.update({ where: { id: c.userId }, data: { callerNumber: null, callerNumberSince: null } });
      for (const c of changed) if (c.to) await tx.user.update({ where: { id: c.userId }, data: { callerNumber: c.to, callerNumberSince: now } });
      for (const a of aliasAdds) await tx.user.update({ where: { id: a.id }, data: { aliases: a.aliases } });
      for (const c of changed) await logAudit({ entityType: 'user', entityId: c.userId, action: 'caller_number_synced', actor: SYSTEM_ACTOR, details: { from: c.from, to: c.to, source: 'h00ks' } }, tx);
    });
  }
  return { changed, identitiesAdded: aliasAdds.length, unmatched };
}

/** Before each call import (src/worker/index.ts): read h00ks and apply it. A failure keeps the numbers as they were. */
export async function syncH00ksNumbers(opts: { now?: Date; fetchImpl?: typeof fetch; token?: string; baseUrl?: string } = {}): Promise<NumberSyncResult> {
  const now = opts.now ?? new Date();
  if (!opts.token && !h00ksConfigured()) return { ran: false, reason: 'H00KS_API_TOKEN is not set.', changed: [], identitiesAdded: 0, unmatched: [] };
  let result: NumberSyncResult;
  try {
    const staff = await fetchH00ksStaff(opts);
    result = { ran: true, ...(await applyH00ksNumbers(staff, now)) };
  } catch (err) {
    const previous = await h00ksStatus();
    result = { ran: true, error: err instanceof Error ? err.message : String(err), changed: [], identitiesAdded: 0, unmatched: previous.unmatched };
  }
  const value = { at: now.toISOString(), error: result.error ?? null, unmatched: result.unmatched, ...(result.error ? {} : { okAt: now.toISOString() }) };
  const prev = await prisma.setting.findUnique({ where: { key: STATUS_KEY } });
  const okAt = (value as { okAt?: string }).okAt ?? (prev?.value as { okAt?: string } | null)?.okAt ?? null;
  await prisma.setting.upsert({ where: { key: STATUS_KEY }, create: { key: STATUS_KEY, value: { ...value, okAt } }, update: { value: { ...value, okAt } } });
  return result;
}

/** For Settings > Calling: when h00ks was last read, what it said if it failed, and who it could not match. */
export async function h00ksStatus(): Promise<{ lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; unmatched: H00ksUnmatched[] }> {
  const row = await prisma.setting.findUnique({ where: { key: STATUS_KEY } });
  const v = (row?.value ?? null) as { at?: string; okAt?: string | null; error?: string | null; unmatched?: H00ksUnmatched[] } | null;
  return { lastRunAt: v?.at ?? null, lastOkAt: v?.okAt ?? null, lastError: v?.error ?? null, unmatched: v?.unmatched ?? [] };
}
