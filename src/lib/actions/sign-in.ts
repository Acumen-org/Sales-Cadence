'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '../auth/current-user';
import { logAudit, userActor } from '../audit';
import { env } from '../env';
import { getSettings, saveSettingsSection } from '../settings';
import type { ActionResult } from './users';

const guid = z.string().uuid();

/** Microsoft accepts the app, tenant and secret together only when they belong together. */
async function microsoftAccepts(clientId: string, tenantId: string, secret: string): Promise<string | null> {
  try {
    const res = await fetch(`${env().MICROSOFT_LOGIN_URL.replace(/\/+$/, '')}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'https://graph.microsoft.com/.default' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error_description?: string };
    return `Microsoft refused these details: ${String(body.error_description ?? res.status).split(/\r?\n/)[0]}`;
  } catch {
    return 'Microsoft could not be reached. Try again.';
  }
}

export async function saveSignInSettingsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const { signIn } = await getSettings();
  const clientId = String(formData.get('microsoftClientId') ?? '').trim().toLowerCase();
  const tenantId = String(formData.get('microsoftTenantId') ?? '').trim().toLowerCase();
  const typed = String(formData.get('microsoftClientSecret') ?? '').trim();
  const secret = formData.get('clearSecret') === 'on' ? '' : typed || signIn.microsoftClientSecret;
  if (clientId && !guid.safeParse(clientId).success) return { ok: false, error: 'Enter the application (client) ID from the app registration.' };
  if (tenantId && !guid.safeParse(tenantId).success) return { ok: false, error: 'Enter the directory (tenant) ID from the app registration.' };
  // The secret's ID is a GUID too, and is easy to copy by mistake.
  if (typed && guid.safeParse(typed).success) return { ok: false, error: "That is the secret's ID. Paste its value." };
  if (clientId && tenantId && secret) {
    const refused = await microsoftAccepts(clientId, tenantId, secret);
    if (refused) return { ok: false, error: refused };
  }
  await saveSettingsSection('signIn', { ...signIn, microsoftClientId: clientId, microsoftTenantId: tenantId, microsoftClientSecret: secret });
  await logAudit({ entityType: 'settings', entityId: 'signIn', action: 'updated', actor: userActor(admin), details: { microsoftClientId: clientId, microsoftTenantId: tenantId, secretSet: Boolean(secret), secretChanged: Boolean(typed) || !secret } });
  revalidatePath('/settings');
  revalidatePath('/login');
  return { ok: true, message: 'Sign-in saved.' };
}
