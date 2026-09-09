'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '../auth/current-user';
import { assertAllowed } from '../auth/rbac';
import { getTwentyClient } from '../twenty';
import { applyEnrichmentChunk, canEnrich, ENRICHMENT_FIELDS, parseEnrichmentUpload, previewEnrichment, reviewEnrichmentRows, suggestEnrichmentMapping, type EnrichmentEntity } from '../enrichment';

const message = (error: unknown) => error instanceof Error ? error.message : 'The import could not be processed.';

export async function inspectEnrichmentUploadAction(entity: EnrichmentEntity, source: string) {
  const user = await requireUser();
  try {
    assertAllowed(canEnrich(user));
    if (!['person', 'company'].includes(entity)) throw new Error('Choose contacts or accounts.');
    const parsed = parseEnrichmentUpload(source);
    return { ok: true as const, headers: parsed.headers, sample: parsed.rows.slice(0, 3), rowCount: parsed.rows.length, mapping: suggestEnrichmentMapping(parsed.headers, entity), fields: ENRICHMENT_FIELDS[entity] };
  } catch (error) { return { ok: false as const, error: message(error) }; }
}

export async function previewEnrichmentAction(entity: EnrichmentEntity, name: string, source: string, mapping: Record<string, string>) {
  const user = await requireUser();
  try {
    const id = await previewEnrichment(user, entity, name, source, mapping);
    revalidatePath('/enrichment');
    return { ok: true as const, id };
  } catch (error) { return { ok: false as const, error: message(error) }; }
}

export async function reviewEnrichmentAction(batchId: string, ids: string[], decision: 'approve' | 'skip' | 'retry') {
  const user = await requireUser();
  try {
    if (!['approve', 'skip', 'retry'].includes(decision)) throw new Error('Choose a review action.');
    await reviewEnrichmentRows(user, batchId, ids, decision);
    revalidatePath(`/enrichment/${batchId}`);
    return { ok: true as const };
  } catch (error) { return { ok: false as const, error: message(error) }; }
}

export async function applyEnrichmentAction(batchId: string) {
  const user = await requireUser();
  try {
    const result = await applyEnrichmentChunk(user, batchId, await getTwentyClient());
    revalidatePath('/enrichment');
    revalidatePath(`/enrichment/${batchId}`);
    revalidatePath('/people');
    revalidatePath('/accounts');
    return { ok: true as const, ...result };
  } catch (error) { return { ok: false as const, error: message(error) }; }
}
