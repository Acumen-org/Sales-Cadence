'use server';
import { requireAdmin } from '../auth/current-user';
import { deleteCampaignPermanently } from '../campaign-delete';
import { revalidatePath } from 'next/cache';

export async function deleteCampaignAction(id: string, name: string) {
  try {
    const result = await deleteCampaignPermanently(id, name, await requireAdmin());
    for (const path of ['/campaigns', '/people', '/tasks', '/activity', '/reports', '/home']) revalidatePath(path);
    return { ok: true as const, ...result };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : 'Could not delete this campaign.' }; }
}
