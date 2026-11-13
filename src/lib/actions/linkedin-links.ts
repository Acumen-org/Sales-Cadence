'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser } from '../auth/current-user';
import { logAudit, userActor } from '../audit';
import { nextActionAccess } from '../next-actions';
import { canReadPerson } from '../people-scope';
import { cachedPersonName } from '../person-cache';
import { linkedinHref, normalizeLinkedin } from '../sandbox/normalize';
import { getTwentyClient } from '../twenty';
import { logOwnPersonWrite } from '../twenty/own-writes';
import type { ActionResult } from './users';

/**
 * Add a CRM person's LinkedIn profile link, so Cadence can match LinkedIn activity to them. Saved to
 * the CRM first, then to Cadence's copy. Whoever may set a next action on the person may add it;
 * Biz Ops only reads. LinkedIn events from then on match this person (a CRM person comes before a cold
 * contact with the same link); events already processed stay where they were matched.
 */
export async function addPersonLinkedinLinkAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!(await nextActionAccess(user)).canSet) return { ok: false, error: 'Biz Ops has read-only access.' };
  const personId = String(formData.get('personId') ?? '').trim();
  const person = personId ? await prisma.personCache.findUnique({ where: { id: personId } }) : null;
  if (!person || person.deletedAt || !(await canReadPerson(user, personId))) return { ok: false, error: 'This person is no longer in the CRM.' };
  const key = normalizeLinkedin(String(formData.get('linkedinUrl') ?? ''));
  if (!key) return { ok: false, error: 'Paste their LinkedIn profile link, like linkedin.com/in/jane-doe.' };
  if (person.linkedinKey === key) return { ok: true, message: 'Already saved.' };
  if (person.linkedinKey) return { ok: false, error: 'They already have a LinkedIn link. Change it in the CRM.' };
  const other = await prisma.personCache.findFirst({ where: { linkedinKey: key, deletedAt: null, id: { not: personId } }, select: { id: true, firstName: true, lastName: true, email: true } });
  if (other) return { ok: false, error: `${cachedPersonName(other)} already has this LinkedIn link.` };
  const href = linkedinHref(key)!;
  const client = await getTwentyClient();
  try {
    await client.enrichPerson(personId, { linkedinUrl: href });
  } catch (err) {
    return { ok: false, error: `The CRM did not save it: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Dry run: the write was only logged, so Cadence's copy keeps what the CRM still has.
  if (client.kind === 'dry-run') return { ok: true, message: 'Dry run: the CRM was not changed.' };
  // B033: a moved person's updatedAt after Cadence's own write, so Undo does not mistake it for an edit.
  await logOwnPersonWrite(client, personId, 'enrichPerson', { id: personId, linkedinUrl: href });
  await prisma.personCache.update({ where: { id: personId }, data: { linkedinUrl: href, linkedinKey: key } });
  await logAudit({ entityType: 'person', entityId: personId, action: 'linkedin_link_added', actor: userActor(user), details: { linkedinUrl: href } });
  revalidatePath(`/people/${personId}`);
  return { ok: true, message: 'LinkedIn link saved.' };
}
