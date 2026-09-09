'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canEnroll } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import type { ActionResult } from './users';
import { paginate } from '../twenty/client';

const RelationSchema = z.object({
  personId: z.string().min(1),
  reportsToId: z.string().optional().transform((v) => (v && v !== '__none__' ? v : null)),
  accountRole: z.enum(['CHAMPION', 'SUPPORTER', 'NEUTRAL', 'DETRACTOR', 'UNKNOWN']).optional(),
  relationshipNote: z.string().max(2000).optional(),
});

/**
 * Edit the local relationship map: reporting line, stance and note.
 * Cadence-only; Twenty is never written.
 */
export async function saveRelationshipAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canEnroll(toActor(user))) return { ok: false, error: 'Only Senior FOs and Admins can edit the relationship map.' };
  const parsed = RelationSchema.safeParse({
    personId: formData.get('personId'),
    reportsToId: formData.get('reportsToId') ?? undefined,
    accountRole: formData.get('accountRole') ?? undefined,
    relationshipNote: formData.get('relationshipNote') ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Invalid request.' };
  const d = parsed.data;

  const person = await prisma.personCache.findUnique({ where: { id: d.personId }, select: { id: true, companyId: true } });
  if (!person) return { ok: false, error: 'Person not found.' };

  if (d.reportsToId) {
    if (d.reportsToId === d.personId) return { ok: false, error: 'Someone cannot report to themselves.' };
    const manager = await prisma.personCache.findUnique({ where: { id: d.reportsToId }, select: { id: true, companyId: true, reportsToId: true } });
    if (!manager) return { ok: false, error: 'That manager was not found.' };
    if (manager.companyId !== person.companyId) return { ok: false, error: 'Pick a manager at the same account.' };
    // Walk up from the proposed manager: if we reach this person, the line would loop.
    let cursor: string | null = manager.reportsToId;
    for (let i = 0; i < 50 && cursor; i++) {
      if (cursor === d.personId) return { ok: false, error: 'That would create a loop in the reporting line.' };
      cursor = (await prisma.personCache.findUnique({ where: { id: cursor }, select: { reportsToId: true } }))?.reportsToId ?? null;
    }
  }

  await prisma.personCache.update({
    where: { id: d.personId },
    data: {
      reportsToId: d.reportsToId,
      ...(d.accountRole ? { accountRole: d.accountRole } : {}),
      ...(d.relationshipNote !== undefined ? { relationshipNote: d.relationshipNote.trim() || null } : {}),
    },
  });
  await logAudit({
    entityType: 'person',
    entityId: d.personId,
    action: 'relationship_updated',
    actor: userActor(user),
    details: { reportsToId: d.reportsToId, accountRole: d.accountRole ?? null },
  });
  if (person.companyId) revalidatePath(`/accounts/${person.companyId}`);
  revalidatePath(`/people/${d.personId}`);
  return { ok: true, message: 'Relationship saved.' };
}

/** Pull this company and its people from Twenty right now. */
export async function syncAccountAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) return { ok: false, error: 'Missing account.' };
  try {
    const { getTwentyClient } = await import('../twenty');
    const { upsertCompanyCache, upsertPersonCache } = await import('../person-cache');
    const client = await getTwentyClient();
    const companies = await client.listCompanies({ ids: [companyId], limit: 1 });
    const company = companies.items[0];
    if (company) await upsertCompanyCache(company);
    let people = 0;
    for await (const person of paginate((after) => client.listPeople({ after, companyId, limit: 100 }))) {
      await upsertPersonCache(person);
      people += 1;
    }
    await logAudit({ entityType: 'person', entityId: companyId, action: 'account_synced', actor: userActor(user), details: { people } });
    revalidatePath(`/accounts/${companyId}`);
    revalidatePath('/accounts');
    return { ok: true, message: `Synced from Twenty: ${company ? 'account details and ' : ''}${people} people.` };
  } catch (err) {
    return { ok: false, error: `Sync failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
