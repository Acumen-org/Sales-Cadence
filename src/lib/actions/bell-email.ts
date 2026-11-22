'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireAdmin, requireUser } from '../auth/current-user';
import { logAudit, userActor } from '../audit';
import { EMAIL_MODES, sendTestEmail } from '../bell-email/run';
import type { ActionResult } from './users';

const WORDS: Record<string, string> = {
  smart: 'Saved. What needs you is emailed within minutes; the rest comes in your morning summary.',
  digest: 'Saved. You get one morning summary on weekdays.',
  off: 'Saved. Cadence will not email you. Your bell still shows everything.',
};

/** Each person chooses how the bell emails them (owner, 21 Nov 2026). */
export async function setEmailPreferenceAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const mode = String(formData.get('mode') ?? '');
  if (!(EMAIL_MODES as readonly string[]).includes(mode)) return { ok: false, error: 'Pick one of the three choices.' };
  await prisma.user.update({ where: { id: user.id }, data: { emailNotifications: mode } });
  await logAudit({ entityType: 'user', entityId: user.id, action: 'email_preference', actor: userActor(user), details: { mode } });
  revalidatePath('/email-preferences');
  return { ok: true, message: WORDS[mode] };
}

/** Settings > Meetings and email: a test email to the admin's own address. */
export async function sendTestEmailAction(): Promise<ActionResult> {
  const admin = await requireAdmin();
  const r = await sendTestEmail(admin);
  revalidatePath('/settings');
  return r.ok ? { ok: true, message: `Sent to ${admin.email}. Check your inbox.` } : { ok: false, error: r.error };
}
