'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireAdmin } from '../auth/current-user';
import { userActor } from '../audit';
import { blockAccount, unblockAccount } from '../blocked-accounts';
import type { ActionResult } from './users';

/** Blocking and unblocking an account is an admin decision; see lib/blocked-accounts.ts for what it does. */
export async function blockAccountAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const companyId = String(formData.get('companyId') ?? '').trim();
  if (!companyId) return { ok: false, error: 'Choose an account to block.' };
  const result = await blockAccount(companyId, { reason: String(formData.get('reason') ?? ''), actor: userActor(admin), byUserId: admin.id });
  if (!result.ok) return result;
  revalidate(companyId);
  return { ok: true, message: result.endedEnrollments ? `${result.name} is blocked. ${result.endedEnrollments} sequence${result.endedEnrollments === 1 ? '' : 's'} ended.` : `${result.name} is blocked.` };
}

export async function unblockAccountAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const companyId = String(formData.get('companyId') ?? '').trim();
  const result = await unblockAccount(companyId, { actor: userActor(admin) });
  if (!result.ok) return result;
  revalidate(companyId);
  return { ok: true, message: `${result.name} is back in Cadence.` };
}

function revalidate(companyId: string) {
  revalidatePath('/home');
  revalidatePath('/tasks');
  revalidatePath('/campaigns');
  revalidatePath('/accounts');
  revalidatePath(`/accounts/${companyId}`);
  revalidatePath('/people');
  revalidatePath('/enrichment');
  revalidatePath('/settings');
}

/** Accounts an admin can pick from when blocking one by name. */
export async function searchAccountsToBlock(q: string): Promise<{ id: string; name: string; domain: string | null }[]> {
  await requireAdmin();
  const term = q.trim();
  if (term.length < 2) return [];
  const blocked = (await prisma.blockedAccount.findMany({ select: { companyId: true } })).map((row) => row.companyId);
  const rows = await prisma.companyCache.findMany({
    where: {
      deletedAt: null,
      ...(blocked.length ? { id: { notIn: blocked } } : {}),
      OR: [{ name: { contains: term, mode: 'insensitive' } }, { domain: { contains: term, mode: 'insensitive' } }],
    },
    orderBy: [{ sortName: { sort: 'asc', nulls: 'last' } }],
    take: 20,
    select: { id: true, name: true, domain: true },
  });
  return rows.map((row) => ({ id: row.id, name: row.name.trim() || row.domain || '(no name)', domain: row.domain }));
}
