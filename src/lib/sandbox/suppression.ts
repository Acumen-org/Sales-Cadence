import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { normalizeEmail, normalizeLinkedin, personalPhone, readExtraPhones, toE164 } from './normalize';

/**
 * The one suppression list (plan section 13). Values are SHA-256 of the normalised value, so an
 * erased contact leaves no readable personal data behind and a later push of the same person is
 * still refused. Checked on push, on manual add, in sandbox campaign audiences, before Cadence's
 * Call button and before Graph closes steps.
 */

export type SuppressionKind = 'email' | 'phone' | 'linkedin' | 'bellwether_id';
export type SuppressionReason = 'opted_out' | 'erased' | 'do_not_contact';
type Tx = Prisma.TransactionClient | typeof prisma;

export function suppressionHash(kind: SuppressionKind, value: string): string {
  return createHash('sha256').update(`${kind}:${value}`).digest('hex');
}

/** The normalised value of a raw one, or null when it does not parse. */
export function normalizedFor(kind: SuppressionKind, raw: string): string | null {
  if (kind === 'email') return normalizeEmail(raw);
  if (kind === 'phone') return toE164(raw);
  if (kind === 'linkedin') return normalizeLinkedin(raw);
  return raw.trim() || null;
}

/** j***@acme.com, +1 *** *** 0123: enough to recognise an entry, not enough to contact anyone. */
export function maskValue(kind: SuppressionKind, value: string): string {
  if (kind === 'email') {
    const [local, domain] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (kind === 'phone') return `${value.slice(0, 2)} *** *** ${value.slice(-4)}`;
  if (kind === 'linkedin') return `linkedin.com/in/${value.split('/').pop()?.slice(0, 2) ?? ''}***`;
  return `${value.slice(0, 4)}***`;
}

export type SuppressionKey = { kind: SuppressionKind; value: string };

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

/** The first key that is suppressed, or null. */
export async function findSuppressed(keys: SuppressionKey[], tx: Tx = prisma): Promise<SuppressionKey | null> {
  if (!keys.length) return null;
  const hashes = keys.map((k) => suppressionHash(k.kind, k.value));
  const rows = await tx.suppression.findMany({ where: { valueHash: { in: hashes } }, select: { kind: true, valueHash: true } });
  if (!rows.length) return null;
  const hit = new Set(rows.map((r) => `${r.kind}:${r.valueHash}`));
  return keys.find((k) => hit.has(`${k.kind}:${suppressionHash(k.kind, k.value)}`)) ?? null;
}

/** Hashes already on the list, of every kind, for checking many contacts at once. */
export async function suppressedHashes(keys: SuppressionKey[], tx: Tx = prisma): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await tx.suppression.findMany({ where: { valueHash: { in: keys.map((k) => suppressionHash(k.kind, k.value)) } }, select: { valueHash: true } });
  return new Set(rows.map((r) => r.valueHash));
}

export async function addSuppressions(keys: SuppressionKey[], meta: { reason: SuppressionReason; sandboxContactId?: string | null; personId?: string | null; createdById?: string | null }, tx: Tx = prisma): Promise<number> {
  let added = 0;
  for (const k of keys) {
    const valueHash = suppressionHash(k.kind, k.value);
    const before = await tx.suppression.count({ where: { kind: k.kind, valueHash } });
    await tx.suppression.upsert({
      where: { kind_valueHash: { kind: k.kind, valueHash } },
      create: { kind: k.kind, valueHash, label: maskValue(k.kind, k.value), reason: meta.reason, sandboxContactId: meta.sandboxContactId ?? null, personId: meta.personId ?? null, createdById: meta.createdById ?? null },
      update: {},
    });
    if (!before) added += 1;
  }
  return added;
}
