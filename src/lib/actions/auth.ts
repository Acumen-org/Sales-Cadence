'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '../db';
import { env } from '../env';
import { verifyPassword } from '../auth/password';
import { createSession, destroySession } from '../auth/session';
import { logAudit, userActor } from '../audit';

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') || undefined,
  });
  if (!parsed.success) return { error: 'Enter your email and password.' };
  const { email, password, next } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
    return { error: 'Email or password is incorrect.' };
  }
  await createSession(user.id);
  await logAudit({ entityType: 'user', entityId: user.id, action: 'login', actor: userActor(user) });
  redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : '/home');
}

/**
 * One-click sign-in for the demo workspace. Only works while TWENTY_MODE=mock and only for
 * the seeded demo accounts, so it can never be used against a real deployment.
 */
export async function demoLoginAction(formData: FormData): Promise<void> {
  if (env().TWENTY_MODE !== 'mock') redirect('/login');
  const email = String(formData.get('email') ?? '').toLowerCase();
  const allowed = /^(admin|alisa|leigh|andrew|karson|daniel|ria)@cadence\.local$/.test(email);
  const user = allowed ? await prisma.user.findUnique({ where: { email } }) : null;
  if (!user || !user.active) redirect('/login');
  await createSession(user.id);
  await logAudit({ entityType: 'user', entityId: user.id, action: 'login', actor: userActor(user), details: { demo: true } });
  redirect('/home');
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect('/login');
}
