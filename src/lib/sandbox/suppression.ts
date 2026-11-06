import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { normalizeCrd, normalizeEmail, normalizeLinkedin, personalPhone, readExtraPhones, toE164 } from './normalize';

/**
 * The one suppression list (plan section 13). Values are SHA-256 of the normalised value, so an
 * erased contact leaves no readable personal data behind and a later push of the same person is
 * still refused. Checked on push, on manual add, in sandbox campaign audiences, before Cadence's
 * Call button and before Graph closes steps.
 */

/**
 * email, phone (a direct or mobile number), linkedin, bellwether_id and individual_crd protect whoever
 * holds the value. phone_subject is a firm main, office or unknown line: it protects only the one
 * person in `subjectId`, so a shared line never blocks or opts out a colleague (PLAN 8.2).
 */
export type SuppressionKind = 'email' | 'phone' | 'linkedin' | 'bellwether_id' | 'individual_crd' | 'phone_subject';
export type SuppressionReason = 'opted_out' | 'erased' | 'do_not_contact';
type Tx = Prisma.TransactionClient | typeof prisma;

export function suppressionHash(kind: SuppressionKind, value: string): string {
  return createHash('sha256').update(`${kind}:${value}`).digest('hex');
}

/** The normalised value of a raw one, or null when it does not parse. */
export function normalizedFor(kind: SuppressionKind, raw: string): string | null {
  if (kind === 'email') return normalizeEmail(raw);
  if (kind === 'phone' || kind === 'phone_subject') return toE164(raw);
  if (kind === 'linkedin') return normalizeLinkedin(raw);
  if (kind === 'individual_crd') return normalizeCrd(raw);
  return raw.trim() || null;
}

/** j***@acme.com, +1 *** *** 0123: enough to recognise an entry, not enough to contact anyone. */
export function maskValue(kind: SuppressionKind, value: string): string {
  if (kind === 'email') {
    const [local, domain] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (kind === 'phone' || kind === 'phone_subject') return `${value.slice(0, 2)} *** *** ${value.slice(-4)}`;
  if (kind === 'individual_crd') return `CRD ***${value.slice(-3)}`;
  if (kind === 'linkedin') return `linkedin.com/in/${value.split('/').pop()?.slice(0, 2) ?? ''}***`;
  return `${value.slice(0, 4)}***`;
}

/** A value to suppress or check. `subjectId` is set on a phone_subject key, and only there. */
export type SuppressionKey = { kind: SuppressionKind; value: string; subjectId?: string | null };

/** Every key that identifies a contact: its emails, personal phones, LinkedIn and Bellwether ids. */
export function contactKeys(c: { email?: string | null; additionalEmails?: string[]; phone?: string | null; phoneType?: string | null; additionalPhones?: unknown; linkedinUrl?: string | null; bellwetherContactId?: string | null; bellwetherAliases?: string[] }, opts: { allPhones?: boolean } = {}): SuppressionKey[] {
  const keys: SuppressionKey[] = [];
  for (const e of [c.email, ...(c.additionalEmails ?? [])]) { const v = normalizeEmail(e); if (v) keys.push({ kind: 'email', value: v }); }
  const phones = [{ number: c.phone ?? '', type: c.phoneType ?? 'unknown' }, ...readExtraPhones(c.additionalPhones)];
  for (const p of phones) {
    if (!opts.allPhones && !personalPhone(p.type)) continue;
    const v = toE164(p.number);
    if (v) keys.push({ kind: 'phone', value: v });
  }
  const li = normalizeLinkedin(c.linkedinUrl);
  if (li) keys.push({ kind: 'linkedin', value: li });
  for (const id of [c.bellwetherContactId, ...(c.bellwetherAliases ?? [])]) if (id) keys.push({ kind: 'bellwether_id', value: id });
  return keys;
}

/**
 * Every key of a contact, widened (PLAN 8.2, 9.7 step 6): a direct or mobile phone protects whoever
 * holds it; any other line (office, main, toll-free, unknown) is kept for this one subject only; and
 * the individual CRD follows the person to any firm (B001, B002).
 */
export function widenedKeys(c: Parameters<typeof contactKeys>[0] & { individualCrd?: string | null }, subjectId: string): SuppressionKey[] {
  const keys = contactKeys(c);
  const phones = [{ number: c.phone ?? '', type: c.phoneType ?? 'unknown' }, ...readExtraPhones(c.additionalPhones)];
  for (const p of phones) {
    if (personalPhone(p.type)) continue;
    const v = toE164(p.number);
    if (v && !keys.some((k) => k.kind === 'phone' && k.value === v)) keys.push({ kind: 'phone_subject', value: v, subjectId });
  }
  const crd = normalizeCrd(c.individualCrd);
  if (crd) keys.push({ kind: 'individual_crd', value: crd });
  return keys;
}

/**
 * Every key to check a contact against (B001, B002): its own keys (widenedKeys), and every phone of
 * every type against the global list too, so a number someone asked us never to call stays blocked
 * however it is typed now. A shared line still blocks only its own subject (phone_subject).
 */
export function checkKeysOf(c: Parameters<typeof widenedKeys>[0], subjectId: string, dialled?: string | null): SuppressionKey[] {
  const keys = widenedKeys(c, subjectId);
  const phones = [c.phone, ...readExtraPhones(c.additionalPhones).map((p) => p.number), dialled].map((n) => toE164(n)).filter((n): n is string => Boolean(n));
  for (const v of phones) {
    if (!keys.some((k) => k.kind === 'phone' && k.value === v)) keys.push({ kind: 'phone', value: v });
    if (!keys.some((k) => k.kind === 'phone_subject' && k.value === v)) keys.push({ kind: 'phone_subject', value: v, subjectId });
  }
  return keys;
}

/**
 * A CRM person's own keys (N011). Twenty does not say whether a number is a direct line, so a CRM
 * phone is kept for this one person (phone_subject): an office line shared with colleagues never
 * blocks or opts them out. Emails and LinkedIn are the person's own and protect them anywhere.
 */
export function personKeys(p: { id: string; emailNorm?: string | null; email?: string | null; additionalEmailsNorm?: string[]; additionalEmails?: string[]; phoneE164?: string | null; additionalPhoneE164?: string | null; linkedinUrl?: string | null }): SuppressionKey[] {
  const keys: SuppressionKey[] = [];
  const emails = [p.emailNorm ?? normalizeEmail(p.email), ...(p.additionalEmailsNorm?.length ? p.additionalEmailsNorm : (p.additionalEmails ?? []).map((e) => normalizeEmail(e)))];
  for (const e of new Set(emails)) if (e) keys.push({ kind: 'email', value: e });
  for (const n of new Set([toE164(p.phoneE164), toE164(p.additionalPhoneE164)])) if (n) keys.push({ kind: 'phone_subject', value: n, subjectId: p.id });
  const li = normalizeLinkedin(p.linkedinUrl);
  if (li) keys.push({ kind: 'linkedin', value: li });
  return keys;
}

/** A CRM person's keys to check: their own, and each of their numbers against the global list too. */
export function personCheckKeys(p: Parameters<typeof personKeys>[0], dialled?: string | null): SuppressionKey[] {
  const keys = personKeys(p);
  for (const v of [p.phoneE164, p.additionalPhoneE164, dialled].map((n) => toE164(n)).filter((n): n is string => Boolean(n))) {
    if (!keys.some((k) => k.kind === 'phone' && k.value === v)) keys.push({ kind: 'phone', value: v });
    if (!keys.some((k) => k.kind === 'phone_subject' && k.value === v)) keys.push({ kind: 'phone_subject', value: v, subjectId: p.id });
  }
  return keys;
}

/** A key as kept on a tombstone: the hash only, never the value (N027). */
export type KeptKey = { kind: SuppressionKind; valueHash: string; label: string | null; subjectId: string | null };
export const keepKeys = (keys: SuppressionKey[]): KeptKey[] => keys.map((k) => ({ kind: k.kind, valueHash: suppressionHash(k.kind, k.value), label: maskValue(k.kind, k.value), subjectId: k.kind === 'phone_subject' ? k.subjectId ?? null : null }));

/** Suppress keys kept as hashes on a tombstone whose details were cleared (N027). */
export async function addKeptSuppressions(kept: KeptKey[], meta: { reason: SuppressionReason; source?: string | null; sandboxContactId?: string | null; personId?: string | null; createdById?: string | null }, tx: Tx = prisma): Promise<number> {
  const rows = kept.filter((k) => k.valueHash && (k.kind !== 'phone_subject' || k.subjectId));
  if (!rows.length) return 0;
  const { count } = await tx.suppression.createMany({
    data: rows.map((k) => ({ kind: k.kind, valueHash: k.valueHash, label: k.label, reason: meta.reason, source: meta.source ?? null, subjectId: k.kind === 'phone_subject' ? k.subjectId : null, sandboxContactId: meta.sandboxContactId ?? null, personId: meta.personId ?? null, createdById: meta.createdById ?? null })),
    skipDuplicates: true,
  });
  return count;
}

export function readKeptKeys(value: unknown): KeptKey[] {
  return Array.isArray(value) ? value.filter((k): k is KeptKey => Boolean(k && typeof k === 'object' && typeof (k as KeptKey).valueHash === 'string' && typeof (k as KeptKey).kind === 'string')) : [];
}

/** The first key that is suppressed, or null. A phone_subject row counts only for its own subject. */
export async function findSuppressed(keys: SuppressionKey[], tx: Tx = prisma): Promise<SuppressionKey | null> {
  if (!keys.length) return null;
  const hashes = keys.map((k) => suppressionHash(k.kind, k.value));
  const rows = await tx.suppression.findMany({ where: { valueHash: { in: hashes } }, select: { kind: true, valueHash: true, subjectId: true } });
  if (!rows.length) return null;
  return keys.find((k) => {
    const hash = suppressionHash(k.kind, k.value);
    return rows.some((r) => r.kind === k.kind && r.valueHash === hash && (r.subjectId === null || r.subjectId === (k.subjectId ?? null)));
  }) ?? null;
}

/**
 * Add keys to the list; a value already on it keeps its first row (and that row's source). `source`
 * is the opt-out that wrote the rows, so lifting a form opt-out removes only its own (D4). Returns how
 * many rows were new.
 */
export async function addSuppressions(keys: SuppressionKey[], meta: { reason: SuppressionReason; source?: string | null; sandboxContactId?: string | null; personId?: string | null; createdById?: string | null }, tx: Tx = prisma): Promise<number> {
  // A shared-line key without its subject would block everyone on the line: never written.
  keys = keys.filter((k) => k.kind !== 'phone_subject' || k.subjectId);
  if (!keys.length) return 0;
  // ON CONFLICT DO NOTHING honours both partial unique keys (Suppression_global_key, Suppression_subject_key).
  const { count } = await tx.suppression.createMany({
    data: keys.map((k) => ({
      kind: k.kind, valueHash: suppressionHash(k.kind, k.value), label: maskValue(k.kind, k.value), reason: meta.reason, source: meta.source ?? null,
      subjectId: k.kind === 'phone_subject' ? k.subjectId ?? null : null,
      sandboxContactId: meta.sandboxContactId ?? null, personId: meta.personId ?? null, createdById: meta.createdById ?? null,
    })),
    skipDuplicates: true,
  });
  return count;
}
