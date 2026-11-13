import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { adminLoginAction, loginAction } from '@/lib/actions/auth';
import { microsoftUser, SignInError, trustedLoginUrl } from '@/lib/auth/microsoft';
import { validatePasswordStrength } from '@/lib/auth/password';
import { LIMITS, takeAttempt } from '@/lib/auth/signin-throttle';
import { resetEnvCache } from '@/lib/env';

vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));

/** Audit 15 (Cadence security), the sign-in findings. */
let b: Basics;
const form = (email: string, password: string) => { const fd = new FormData(); fd.set('email', email); fd.set('password', password); return fd; };
const signIn = async (action: typeof loginAction, email: string, password: string) => {
  try { return await action(undefined, form(email, password)); } catch (err) { return String((err as Error).message); }
};
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (err) { return err instanceof SignInError ? err.code : String(err); } };

beforeEach(async () => { await resetDb(); b = await seedBasics(); });

describe('password guessing (Q02, Q08, Q09)', () => {
  it('the normal sign-in form stops after five wrong passwords for an address, and a right one counts nothing', async () => {
    expect(await signIn(loginAction, b.users.alisa.email, 'password123')).toBe('redirect:/home');
    for (let i = 0; i < 5; i++) expect(await signIn(loginAction, b.users.alisa.email, `wrong-${i}`)).toEqual({ error: 'Email or password is incorrect.' });
    expect(await signIn(loginAction, b.users.alisa.email, 'password123')).toEqual({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
  });

  it('parallel tries get no more than the limit', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => takeAttempt('admin', 'x@acumen-strategy.com', '203.0.113.9')));
    expect(results.filter((r) => r.allowed).length).toBeLessThanOrEqual(LIMITS.addressFromCaller);
  });

  it('one caller cannot lock an address for everyone else in a quarter hour', async () => {
    for (let i = 0; i < 6; i++) await takeAttempt('admin', 'ria@acumen-strategy.com', '203.0.113.9');
    expect((await takeAttempt('admin', 'ria@acumen-strategy.com', '203.0.113.9')).allowed).toBe(false);
    expect((await takeAttempt('admin', 'ria@acumen-strategy.com', '198.51.100.4')).allowed).toBe(true);
  });

  it('made-up addresses on the admin page write nothing to the audit log; a real one is logged', async () => {
    for (let i = 0; i < 3; i++) await signIn(adminLoginAction, `nobody-${i}@example.com`, 'whatever');
    expect(await prisma.auditLog.count({ where: { entityType: 'signin' } })).toBe(0);
    await signIn(adminLoginAction, b.users.ria.email, 'wrong');
    expect(await prisma.auditLog.count({ where: { entityType: 'signin', action: 'admin_login_failed' } })).toBe(1);
  });
});

describe('admin passwords (Q11)', () => {
  it('need 12 characters and may not be a well-known one', () => {
    expect(validatePasswordStrength('admin12345', { admin: true })).toMatch(/12 characters/);
    expect(validatePasswordStrength('administrator', { admin: true })).toMatch(/well known/);
    expect(validatePasswordStrength('correct-horse-battery', { admin: true })).toBeNull();
    expect(validatePasswordStrength('password123')).toBeNull();
  });
});

describe('sessions (Q12, Q13)', () => {
  it('keep only a hash of the token, and a token stored before that is re-keyed on use', async () => {
    const { startSession, storedToken } = await import('@/lib/auth/session');
    const s = await startSession(b.users.alisa.id);
    expect(await prisma.session.count({ where: { token: s.value } })).toBe(0);
    expect(await prisma.session.count({ where: { token: storedToken(s.value) } })).toBe(1);
  });

  it('are Secure when the app is served over https and the setting is left unset', async () => {
    const { cookieSecure } = await import('@/lib/auth/session');
    const before = { url: process.env.APP_URL, secure: process.env.COOKIE_SECURE };
    try {
      delete process.env.COOKIE_SECURE; process.env.APP_URL = 'https://cadence.example.com'; resetEnvCache();
      expect(cookieSecure()).toBe(true);
      process.env.COOKIE_SECURE = 'false'; resetEnvCache();
      expect(cookieSecure()).toBe(false);
    } finally {
      if (before.url === undefined) delete process.env.APP_URL; else process.env.APP_URL = before.url;
      if (before.secure === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = before.secure;
      resetEnvCache();
    }
  });
});

describe('Microsoft sign-in (Q04, Q14, Q15)', () => {
  it('an address never moves a team member to a second Microsoft account', async () => {
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { microsoftId: 'oid-a' } });
    expect(await refusal(microsoftUser({ oid: 'oid-b', addresses: [b.users.alisa.email], name: null }))).toBe('microsoft');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).microsoftId).toBe('oid-a');
  });

  it('someone marked removed stays out even with no removal row in the audit log', async () => {
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { active: false, accessRemovedAt: new Date() } });
    expect(await refusal(microsoftUser({ oid: 'oid-a', addresses: [b.users.alisa.email], name: null }))).toBe('removed');
  });

  it('believes only Microsoft’s own sign-in service outside mock mode', () => {
    const before = process.env.CADENCE_ALLOW_MOCK;
    try {
      process.env.CADENCE_ALLOW_MOCK = ''; resetEnvCache();
      expect(trustedLoginUrl('https://login.microsoftonline.com')).toBe(true);
      expect(trustedLoginUrl('http://127.0.0.1:3998')).toBe(false);
      expect(trustedLoginUrl('https://login.microsoftonline.com.evil.example')).toBe(false);
    } finally { process.env.CADENCE_ALLOW_MOCK = before; resetEnvCache(); }
  });
});
