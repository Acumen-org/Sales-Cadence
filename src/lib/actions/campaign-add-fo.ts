'use server';
import { revalidatePath } from 'next/cache';
import { requireUser } from '../auth/current-user';
import { applyAddFo, planAddFo, type AddFoInput } from '../campaign-add-fo';

const failure = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'Something went wrong. Try again.' });

/** Plan a new FO's part of a running campaign, for review; nothing is written. */
export async function planAddFoAction(campaignId: string, input: AddFoInput) {
  try { return await planAddFo(await requireUser(), campaignId, input); } catch (e) { return failure(e); }
}

/** Add the reviewed FO and put their people into outreach. */
export async function applyAddFoAction(campaignId: string, input: AddFoInput, fingerprint: string) {
  try {
    const r = await applyAddFo(await requireUser(), campaignId, input, fingerprint);
    for (const path of [`/campaigns/${campaignId}`, '/campaigns', '/tasks', '/people', '/home']) revalidatePath(path);
    return { ok: true as const, enrolled: r.enrolled };
  } catch (e) { return failure(e); }
}
