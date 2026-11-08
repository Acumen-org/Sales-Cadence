'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../auth/current-user';
import { userActor } from '../audit';
import { createApiKey, revokeApiKey } from '../public-api/keys';
import type { ActionResult } from './users';

/** Admins make read API keys in Settings > API keys; the answer carries the key, shown once. */
export async function createApiKeyAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const never = formData.get('neverExpires') === 'on';
  const days = Number(formData.get('expiresInDays') ?? '');
  const allowedIps = String(formData.get('allowedIps') ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const result = await createApiKey(
    { name: String(formData.get('name') ?? ''), scopes: formData.getAll('scopes').map(String), expiresInDays: never ? null : days, allowedIps },
    { id: admin.id, name: admin.name },
    userActor(admin),
  );
  if (!result.ok) return result;
  revalidatePath('/settings');
  return { ok: true, message: 'Key created. Copy it now: Cadence will not show it again.', data: { key: result.key } };
}

export async function revokeApiKeyAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const result = await revokeApiKey(String(formData.get('id') ?? ''), { name: admin.name }, userActor(admin));
  if (!result.ok) return result;
  revalidatePath('/settings');
  return { ok: true, message: `${result.name} is revoked. Anything still using it gets 401 from now on.` };
}
