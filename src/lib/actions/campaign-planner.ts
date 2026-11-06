'use server';
import { revalidatePath } from 'next/cache';
import { requireUser } from '../auth/current-user';
import { ZodError } from 'zod';
import { previewCampaignCalendar, saveCampaignCalendar, prepareCampaignStudio } from '../campaign-planning-service';

const message = (e: unknown) => e instanceof ZodError ? [...new Set(e.issues.map(i => i.message))].join(' ') : e instanceof Error ? e.message : 'Unable to plan this campaign.';
/** The studio's kind: CRM people or cold contacts (W7). A saved campaign keeps its own; the server refuses a change (B045). */
type Audience = 'CRM' | 'SANDBOX';
const kind = (a: unknown): Audience => (a === 'SANDBOX' ? 'SANDBOX' : 'CRM');

export async function prepareStudioAction(input: unknown, id?: string, fit = false, audience?: Audience) {
  try { return { ok: true as const, data: await prepareCampaignStudio(input, await requireUser(), id, fit, kind(audience)) }; }
  catch (e) { return { ok: false as const, error: message(e) }; }
}
export async function previewCalendarAction(input: unknown, id?: string, audience?: Audience) {
  try { return { ok: true as const, data: await previewCampaignCalendar(input, await requireUser(), id, kind(audience)) }; }
  catch (e) { return { ok: false as const, error: message(e) }; }
}
export async function saveCalendarAction(input: unknown, options: { id?: string; revision?: string; publish?: boolean; fingerprint?: string; auto?: boolean; audience?: Audience }) {
  try {
    const saved = await saveCampaignCalendar(input, await requireUser(), { ...options, audience: kind(options.audience) });
    // A draft save must not re-render the studio it came from (the campaign pages are dynamic and
    // read fresh on the next visit); publishing leaves the studio, so it refreshes them.
    if (options.publish) { revalidatePath('/campaigns'); revalidatePath(`/campaigns/${saved.id}`); }
    return { ok: true as const, id: saved.id, revision: saved.updatedAt.toISOString() };
  } catch (e) { return { ok: false as const, error: message(e) }; }
}
