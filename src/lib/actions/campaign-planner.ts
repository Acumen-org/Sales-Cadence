'use server';
import { revalidatePath } from 'next/cache';
import { requireUser } from '../auth/current-user';
import { ZodError } from 'zod';
import { previewCampaignCalendar, saveCampaignCalendar, prepareCampaignStudio } from '../campaign-planning-service';

const message = (e: unknown) => e instanceof ZodError ? e.issues.map(i => i.message).join(' ') : e instanceof Error ? e.message : 'Unable to plan this campaign.';
export async function prepareStudioAction(input: unknown, id?: string, fit = false) {
  try { return { ok: true as const, data: await prepareCampaignStudio(input, await requireUser(), id, fit) }; }
  catch (e) { return { ok: false as const, error: message(e) }; }
}
export async function previewCalendarAction(input: unknown, id?: string) {
  try { return { ok: true as const, data: await previewCampaignCalendar(input, await requireUser(), id) }; }
  catch (e) { return { ok: false as const, error: message(e) }; }
}
export async function saveCalendarAction(input: unknown, options: { id?: string; revision?: string; publish?: boolean; fingerprint?: string }) {
  try {
    const saved = await saveCampaignCalendar(input, await requireUser(), options);
    revalidatePath('/campaigns'); revalidatePath(`/campaigns/${saved.id}`);
    return { ok: true as const, id: saved.id, revision: saved.updatedAt.toISOString() };
  } catch (e) { return { ok: false as const, error: message(e) }; }
}
