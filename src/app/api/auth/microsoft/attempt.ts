/** The sign-in attempt between leaving for Microsoft and coming back, kept in an httpOnly cookie. */
export const ATTEMPT_COOKIE = 'cadence_microsoft';

export type SignInAttempt = { state: string; nonce: string; verifier: string; next: string; remember: boolean };

export const encodeAttempt = (a: SignInAttempt) => Buffer.from(JSON.stringify(a)).toString('base64url');

export function decodeAttempt(value: string | undefined): SignInAttempt | null {
  if (!value) return null;
  try {
    const a = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SignInAttempt>;
    if (typeof a.state !== 'string' || typeof a.nonce !== 'string' || typeof a.verifier !== 'string') return null;
    return { state: a.state, nonce: a.nonce, verifier: a.verifier, next: typeof a.next === 'string' ? a.next : '/home', remember: a.remember === true };
  } catch {
    return null;
  }
}
