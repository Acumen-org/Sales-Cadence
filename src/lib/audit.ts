import type { ActorType, Prisma } from '@prisma/client';
import { prisma, type Tx } from './db';

/** Who or what caused a state change. Every engine mutation carries one of these. */
export type AuditActor = {
  type: ActorType;
  id?: string | null;
  label?: string | null;
};

export const SYSTEM_ACTOR: AuditActor = { type: 'SYSTEM', label: 'Cadence' };
export const RECONCILE_ACTOR: AuditActor = { type: 'RECONCILE', label: 'Cadence (catch-up)' };

export function userActor(user: { id: string; name?: string | null; email?: string | null }): AuditActor {
  return { type: 'USER', id: user.id, label: user.name ?? user.email ?? user.id };
}

export function webhookActor(eventName: string, externalId?: string): AuditActor {
  return { type: 'WEBHOOK', id: externalId ?? null, label: `twenty:${eventName}` };
}

export type AuditInput = {
  entityType: 'enrollment' | 'task' | 'campaign' | 'sequence' | 'user' | 'settings' | 'pod' | 'person' | 'event' | 'meeting';
  entityId: string;
  action: string;
  actor: AuditActor;
  details?: Prisma.InputJsonValue;
};

export async function logAudit(input: AuditInput, tx: Tx | typeof prisma = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      actorLabel: input.actor.label ?? null,
      details: input.details ?? undefined,
    },
  });
}

export async function recentAudit(entityType: AuditInput['entityType'], entityId: string, limit = 50) {
  return prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
