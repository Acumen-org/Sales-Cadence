'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '../db';
import { verifyNoPassword, verifyPassword } from '../auth/password';
import { createSession, destroySession } from '../auth/session';
import { callerAddress, forgetAttempt, takeAttempt, TRY_WINDOW_MS } from '../auth/signin-throttle';
import { safeReturnPath } from '../auth/redirect';
import { logAudit, SYSTEM_ACTOR, userActor } from '../audit';
import { signInMethods } from '../auth/microsoft';

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  remember: z.string().optional(),
  next: z.string().optional(),
});

export type LoginState = { error?: string } | undefined;

const TOO_MANY = 'Too many wrong passwords. Try again in 15 minutes.';

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    remember: formData.get('remember') || undefined,
    next: formData.get('next') || undefined,
  });
  // Once Microsoft sign-in has worked, a password opens nothing.
  if (!(await signInMethods()).password) return { error: 'Sign in with Microsoft.' };
  if (!parsed.success) return { error: 'Enter your email and password.' };
  const { email, password, remember, next } = parsed.data;
  // Q02: as many guesses as the admin page allows, no more.
  const attempt = await takeAttempt('password', email, await callerAddress());
  if (!attempt.allowed) return { error: TOO_MANY };

  const user = await prisma.user.findUnique({ where: { email } });
  // Q10: a password is checked, or pretended to be, whoever the address belongs to.
  const right = user?.active && user.passwordHash ? await verifyPassword(password, user.passwordHash) : await verifyNoPassword(password);
  if (!user || !right) {
    return { error: 'Email or password is incorrect.' };
  }
  await forgetAttempt(attempt.attemptId);
  await createSession(user.id, remember === 'on');
  await logAudit({ entityType: 'user', entityId: user.id, action: 'login', actor: userActor(user), details: { remembered: remember === 'on' } });
  redirect(safeReturnPath(next));
}

/**
 * /login/admin: an admin signs in with a password even after Microsoft sign-in has retired
 * passwords (owner, 2 November 2026). Anyone who is not an admin is told the email or password is
 * wrong. Audit Q03/Q08/Q09: the door stays, rate-limited by `signin-throttle.ts` (5 wrong tries
 * per address and caller in 15 minutes, 20 per caller, 50 per address a day) and audited: a wrong
 * password for an address that has an account is an `admin_login_failed` row, the lock engaging an
 * `admin_login_locked` row (at most one per 15 minutes); made-up addresses write nothing to the log.
 */
export async function adminLoginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    remember: formData.get('remember') || undefined,
    next: formData.get('next') || undefined,
  });
  if (!parsed.success) return { error: 'Enter your email and password.' };
  const { email, password, remember, next } = parsed.data;
  const ip = await callerAddress();
  const attempt = await takeAttempt('admin', email, ip);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!attempt.allowed) {
    if (user && !(await prisma.auditLog.count({ where: { entityType: 'signin', entityId: email, action: 'admin_login_locked', createdAt: { gte: new Date(Date.now() - TRY_WINDOW_MS) } } }))) {
      await logAudit({ entityType: 'signin', entityId: email, action: 'admin_login_locked', actor: SYSTEM_ACTOR, details: { ip } });
    }
    return { error: TOO_MANY };
  }

  const eligible = Boolean(user && user.active && user.role === 'ADMIN' && user.passwordHash);
  const right = eligible ? await verifyPassword(password, user!.passwordHash) : await verifyNoPassword(password);
  if (!user || !eligible || !right) {
    if (user) await logAudit({ entityType: 'signin', entityId: email, action: 'admin_login_failed', actor: SYSTEM_ACTOR, details: { ip } });
    return { error: 'Email or password is incorrect.' };
  }
  await forgetAttempt(attempt.attemptId);
  await createSession(user.id, remember === 'on');
  await logAudit({ entityType: 'user', entityId: user.id, action: 'login', actor: userActor(user), details: { remembered: remember === 'on', via: 'admin password' } });
  redirect(safeReturnPath(next));
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect('/login');
}
