import type { AuditActor } from './audit';
import { logAudit } from './audit';
import { prisma } from './db';
import { OCCUPYING_STATUSES } from './engine/enrollment';
import { cancelOpenTasks, syncCancelled } from './engine/tasks';
import { lockAccounts } from './account-lock';

/**
 * Accounts an admin has taken out of the platform.
 *
 * The rule is a read filter, not a deletion: the CRM cache keeps every row, so inbound activity
 * still matches the people who work there. Existing mirrored tasks are cancelled in Twenty;
 * CRM people and companies are not changed. What the block does
 * is remove the account and its people from Accounts, People, search, enrichment and campaign
 * audiences, refuse any new enrollment, and end the sequences its people are already in - so no
 * FO is left holding a task for a firm the business has taken off the table. Unblocking brings
 * the account and its people straight back; a sequence that ended stays ended.
 */
export async function blockedCompanyIds(): Promise<string[]> {
  return (await prisma.blockedAccount.findMany({ select: { companyId: true } })).map((row) => row.companyId);
}

export async function isBlockedAccount(companyId: string | null | undefined): Promise<boolean> {
  if (!companyId) return false;
  return (await prisma.blockedAccount.count({ where: { companyId } })) > 0;
}

/** Every blocked account, newest first, with who blocked it. */
export async function listBlockedAccounts() {
  return prisma.blockedAccount.findMany({ orderBy: { createdAt: 'desc' }, include: { blockedBy: { select: { name: true } } } });
}

export type BlockOutcome = { ok: true; name: string; endedEnrollments: number } | { ok: false; error: string };

export async function blockAccount(companyId: string, opts: { reason?: string | null; actor: AuditActor; byUserId?: string | null }): Promise<BlockOutcome> {
  const company = await prisma.companyCache.findUnique({ where: { id: companyId }, select: { id: true, name: true, domain: true } });
  if (!company) return { ok: false, error: 'That account is not in the CRM cache.' };
  const name = company.name.trim() || company.domain || '(no name)';
  const reason = opts.reason?.trim().slice(0, 500) || null;
  const result = await prisma.$transaction(async tx => {
    await lockAccounts(tx, [companyId]);
    if (await tx.blockedAccount.count({ where: { companyId } })) return null;
    await tx.blockedAccount.create({ data: { companyId, name, domain: company.domain, reason, blockedById: opts.byUserId ?? null } });
    const enrollments = await tx.enrollment.findMany({
      where: { status: { in: OCCUPYING_STATUSES }, OR: [{ companyId }, { person: { companyId } }] },
      select: { id: true }, orderBy: { id: 'asc' },
    });
    const cancelledIds: string[] = [];
    for (const enrollment of enrollments) {
      const cancelled = await cancelOpenTasks(tx, enrollment.id, 'exited:account_blocked', opts.actor);
      cancelledIds.push(...cancelled.map(task => task.id));
      await tx.enrollment.update({ where: { id: enrollment.id }, data: { status: 'EXITED', exitReason: 'account_blocked', exitedAt: new Date() } });
      await logAudit({ entityType: 'enrollment', entityId: enrollment.id, action: 'exited', actor: opts.actor, details: { reason: 'account_blocked', cancelledTasks: cancelled.length } }, tx);
    }
    await logAudit({ entityType: 'account', entityId: companyId, action: 'blocked', actor: opts.actor, details: { name, reason, endedEnrollments: enrollments.length } }, tx);
    return { cancelledIds, endedEnrollments: enrollments.length };
  }, { timeout: 30000 });
  if (!result) return { ok: false, error: `${name} is already blocked.` };
  await syncCancelled(result.cancelledIds, { actor: opts.actor });
  return { ok: true, name, endedEnrollments: result.endedEnrollments };
}

export async function unblockAccount(companyId: string, opts: { actor: AuditActor }): Promise<{ ok: true; name: string; reason: string | null } | { ok: false; error: string }> {
  return prisma.$transaction(async tx => {
    await lockAccounts(tx, [companyId]);
    const blocked = await tx.blockedAccount.findUnique({ where: { companyId } });
    if (!blocked) return { ok: false as const, error: 'That account is not blocked.' };
    await tx.blockedAccount.delete({ where: { companyId } });
    await logAudit({ entityType: 'account', entityId: companyId, action: 'unblocked', actor: opts.actor, details: { name: blocked.name } }, tx);
    return { ok: true as const, name: blocked.name, reason: blocked.reason };
  });
}
