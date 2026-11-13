import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

let decoy: Promise<string> | undefined;
/**
 * Audit Q10: the same work as checking a real password, for an address with no account (or no
 * password), so a sign-in form answers no faster for it and does not say which addresses exist.
 */
export async function verifyNoPassword(plain: string): Promise<false> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(plain, await decoy);
  return false;
}

/** Passwords that are known to anyone who has read this repository or a password list. */
const KNOWN = new Set(['admin12345', 'password123', 'password1234', 'change-me-before-first-run', 'administrator', 'cadence123', 'cadence1234', 'qwertyuiop12', '123456789012']);

/**
 * At least 8 characters for everyone. Audit Q11: an admin password, which keeps working for ever
 * through /login/admin, needs 12 and may not be one of the well-known ones.
 */
export function validatePasswordStrength(plain: string, opts: { admin?: boolean } = {}): string | null {
  if (plain.length < 8) return 'Password must be at least 8 characters.';
  if (opts.admin) {
    if (plain.length < 12) return 'An administrator password must be at least 12 characters.';
    if (KNOWN.has(plain.toLowerCase()) || /^(.)\1+$/.test(plain)) return 'That password is too well known. Choose another.';
  }
  return null;
}
