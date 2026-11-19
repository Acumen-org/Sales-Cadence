'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '../auth/current-user';
import { logAudit, userActor } from '../audit';
import { env } from '../env';
import { trustedLoginUrl } from '../auth/microsoft';
import { getSettings, saveSettingsSection } from '../settings';
import { libraryConfig, normaliseSiteUrl, queueExistingRecordings, setLibrary } from '../meetings/library';
import type { ActionResult } from './users';

// Any 8-4-4-4-12 hex id, as Zod 3's uuid() took; Zod 4's uuid() also wants RFC version bits.
const guid = z.guid();

/** Microsoft accepts the app, tenant and secret together only when they belong together. */
async function microsoftAccepts(clientId: string, tenantId: string, secret: string): Promise<string | null> {
  // Q15: the secret goes to Microsoft only.
  if (!trustedLoginUrl(env().MICROSOFT_LOGIN_URL)) return `MICROSOFT_LOGIN_URL (${env().MICROSOFT_LOGIN_URL}) is not Microsoft's sign-in service: remove it from the server's environment.`;
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

/** The Meeting Recordings library's address, saved and checked: Cadence finds the site and can write to it. */
export async function saveMeetingLibraryAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const siteUrl = normaliseSiteUrl(String(formData.get('siteUrl') ?? ''));
  if (!siteUrl) return { ok: false, error: 'Paste the SharePoint site address, like https://contoso.sharepoint.com/sites/MeetingRecordings.' };
  const config = await setLibrary(siteUrl);
  await logAudit({ entityType: 'settings', entityId: 'meetingLibrary', action: 'updated', actor: userActor(admin), details: { siteUrl, ok: config.check?.ok ?? false } });
  revalidatePath('/settings');
  return config.check?.ok ? { ok: true, message: 'Library saved. Cadence can copy recordings into it.' } : { ok: false, error: config.check?.why ?? 'The library could not be checked.' };
}

/** Every recording already in Cadence, queued for the library (failed ones tried again). */
export async function copyExistingRecordingsAction(): Promise<ActionResult> {
  const admin = await requireAdmin();
  const config = await libraryConfig();
  if (!config?.check?.ok) return { ok: false, error: 'Save a library Cadence can write to first.' };
  const queued = await queueExistingRecordings();
  await logAudit({ entityType: 'settings', entityId: 'meetingLibrary', action: 'queued_existing', actor: userActor(admin), details: { queued } });
  revalidatePath('/settings');
  return { ok: true, message: queued ? `${queued} ${queued === 1 ? 'recording' : 'recordings'} queued. The worker copies two every couple of minutes.` : 'Nothing to copy: every recording is in the library or waiting.' };
}
