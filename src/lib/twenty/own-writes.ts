import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { TwentyClient } from './client';

/**
 * B033: Undo of a Move to CRM must tell Cadence's own writes to a person from someone's edit in the
 * CRM. Twenty bumps a person's updatedAt on every write, Cadence's next-action sync included, so
 * after Cadence writes to a person a move made or used, the updatedAt Twenty now reads is kept on the
 * write's log row (TwentyWrite.resultUpdatedAt). Undo then refuses only an updatedAt that is none of
 * Cadence's own. Other people are not read back: the stamp costs one read, and only moves need it.
 */
export async function ownWriteStamp(client: TwentyClient, personId: string): Promise<string | null> {
  if (client.kind === 'dry-run') return null;
  const moved = await prisma.sandboxMoveItem.count({ where: { twentyPersonId: personId, state: { in: ['RUNNING', 'DONE', 'UNDOING', 'UNDO_PARTIAL'] } } });
  if (!moved) return null;
  const person = await client.getPerson(personId).catch(() => null);
  return person?.updatedAt ?? null;
}

/** Log one of Cadence's own writes to a moved person, with the updatedAt it left (see ownWriteStamp). */
export async function logOwnPersonWrite(client: TwentyClient, personId: string, operation: string, payload: Prisma.InputJsonValue): Promise<void> {
  const stamp = await ownWriteStamp(client, personId);
  if (!stamp) return;
  await prisma.twentyWrite.create({ data: { operation, objectType: 'person', twentyId: personId, payload, dryRun: false, resultUpdatedAt: stamp } });
}

/** Every updatedAt Cadence's own writes left on this person since `since`. */
export async function ownStamps(personId: string, since: Date | null): Promise<Set<string>> {
  const rows = await prisma.twentyWrite.findMany({ where: { twentyId: personId, resultUpdatedAt: { not: null }, ...(since ? { createdAt: { gte: since } } : {}) }, select: { resultUpdatedAt: true } });
  return new Set(rows.flatMap((r) => (r.resultUpdatedAt ? [r.resultUpdatedAt] : [])));
}
