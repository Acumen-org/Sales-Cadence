'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '../db';
import { verifyPassword } from '../auth/password';
import { createSession, destroySession } from '../auth/session';
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

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
    return { error: 'Email or password is incorrect.' };
  }
  await createSession(user.id, remember === 'on');
  await logAudit({ entityType: 'user', entityId: user.id, action: 'login', actor: userActor(user), details: { remembered: remember === 'on' } });
  redirect(safeReturnPath(next));
}

/** Wrong passwords on the admin page before it stops trying, and how far back they count. */
const ADMIN_TRIES = 5;
const ADMIN_TRIES_WINDOW_MS = 15 * 60_000;

/**
 * /login/admin: an admin signs in with a password even after Microsoft sign-in has retired
 * passwords (owner, 2 November 2026). Anyone who is not an admin is told the email or password is
 * wrong, as is everyone after five wrong passwords for that address in a quarter of an hour.
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
  const failed = await prisma.auditLog.count({ where: { entityType: 'signin', entityId: email, action: 'admin_login_failed', createdAt: { gte: new Date(Date.now() - ADMIN_TRIES_WINDOW_MS) } } });
  if (failed >= ADMIN_TRIES) return { error: 'Too many wrong passwords. Try again in 15 minutes.' };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active || user.role !== 'ADMIN' || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    await logAudit({ entityType: 'signin', entityId: email, action: 'admin_login_failed', actor: SYSTEM_ACTOR });
    return { error: 'Email or password is incorrect.' };
  }
  await createSession(user.id, remember === 'on');
  await logAudit({ entityType: 'user', entityId: user.id, action: 'login', actor: userActor(user), details: { remembered: remember === 'on', via: 'admin password' } });
  redirect(safeReturnPath(next));
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect('/login');
}
