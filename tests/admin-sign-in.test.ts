import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getSettings, invalidateSettingsCache, saveSettingsSection } from '@/lib/settings';
import { retirePasswords } from '@/lib/auth/microsoft';
import { adminLoginAction, loginAction } from '@/lib/actions/auth';

// A session writes a cookie, which needs a request; a sign-in ends by sending the browser on.
vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));

/**
 * /login/admin (owner, 2 November 2026): an admin signs in with a password even after Microsoft
 * sign-in has retired passwords on /login. Nobody else gets in there.
 */
let b: Basics;
const form = (email: string, password: string) => {
  const fd = new FormData();
  fd.set('email', email);
  fd.set('password', password);
  return fd;
};
const signIn = async (action: typeof adminLoginAction, email: string, password: string) => {
  try { return await action(undefined, form(email, password)); } catch (err) { return String((err as Error).message); }
};

// As on the live workspace: Microsoft set up and signed in with once, so /login takes no passwords.
beforeEach(async () => {
  await resetDb(); b = await seedBasics(); invalidateSettingsCache();
  const { signIn: current } = await getSettings();
  await saveSettingsSection('signIn', { ...current, microsoftClientId: '11111111-1111-4111-8111-111111111111', microsoftTenantId: '22222222-2222-4222-8222-222222222222', microsoftClientSecret: 'secret-value' });
  await retirePasswords();
});

describe('the admin sign-in page', () => {
  it('lets an admin in with a password after passwords are retired everywhere else', async () => {
    expect(await signIn(loginAction, b.users.ria.email, 'password123')).toEqual({ error: 'Sign in with Microsoft.' });
    expect(await signIn(adminLoginAction, b.users.ria.email, 'password123')).toBe('redirect:/home');
    expect(await prisma.session.count({ where: { userId: b.users.ria.id } })).toBe(1);
  });

  it('turns away anyone who is not an admin, and a wrong password, alike', async () => {
    expect(await signIn(adminLoginAction, b.users.alisa.email, 'password123')).toEqual({ error: 'Email or password is incorrect.' });
    expect(await signIn(adminLoginAction, b.users.ria.email, 'wrong')).toEqual({ error: 'Email or password is incorrect.' });
    await prisma.user.update({ where: { id: b.users.ria.id }, data: { active: false } });
    expect(await signIn(adminLoginAction, b.users.ria.email, 'password123')).toEqual({ error: 'Email or password is incorrect.' });
    expect(await prisma.session.count()).toBe(0);
  });

  it('stops trying after five wrong passwords for an address', async () => {
    for (let i = 0; i < 5; i++) await signIn(adminLoginAction, b.users.ria.email, `wrong-${i}`);
    expect(await signIn(adminLoginAction, b.users.ria.email, 'password123')).toEqual({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
    expect(await prisma.session.count()).toBe(0);
  });
});
