import type { Prisma, SandboxStatus } from '@prisma/client';
import { prisma } from '../db';
import { getSettings } from '../settings';
import { formatLocalDate, toLocalDate } from '../dates';
import { workspaceTimezone } from '../workspace';
import { checkReady, readyLabel } from './ready';

/** The Sandbox > Contacts list: one row per contact with what the table shows. */

export const SANDBOX_PAGE = 50;
export type ContactFilters = { q: string; owner: string; status: string; ready: string; podId: string; source: string };

const STATUS_OF: Record<string, SandboxStatus[]> = { active: ['ACTIVE'], unclaimed: ['ACTIVE'], moved: ['MOVED'], opted_out: ['OPTED_OUT'], removed: ['REMOVED'] };

export function contactWhere(f: ContactFilters, userId: string): Prisma.SandboxContactWhereInput {
  const and: Prisma.SandboxContactWhereInput[] = [{ status: { in: STATUS_OF[f.status] ?? ['ACTIVE'] } }];
  if (f.status === 'unclaimed') and.push({ ownerId: null });
  if (f.owner === 'mine') and.push({ ownerId: userId });
  else if (f.owner === 'unclaimed') and.push({ ownerId: null });
  else if (f.owner && f.owner !== 'all') and.push({ ownerId: f.owner });
  if (f.podId) and.push({ podId: f.podId });
  if (f.source) and.push({ source: f.source as Prisma.EnumContactSourceFilter['equals'] });
  for (const term of f.q.trim().split(/\s+/).filter(Boolean).slice(0, 5)) {
    const like = { contains: term, mode: 'insensitive' as const };
    and.push({ OR: [{ firstName: like }, { lastName: like }, { email: like }, { companyName: like }, { jobTitle: like }, { phone: { contains: term.replace(/[^\d+]/g, '') || term } }] });
  }
  return { AND: and };
}

export type ContactRow = {
  id: string; name: string; title: string | null; firm: string | null; owner: string | null; ownerId: string | null; podId: string | null;
  ready: boolean; readyText: string; campaign: { id: string; name: string } | null; nextAction: string | null; lastTouch: string | null;
  calls: number; source: string; status: SandboxStatus; twentyPersonId: string | null; movedAt: Date | null;
};

export async function listContacts(f: ContactFilters, userId: string, page: number): Promise<{ rows: ContactRow[]; total: number; pages: number }> {
  const settings = await getSettings();
  const where = contactWhere(f, userId);
  const all = await prisma.sandboxContact.findMany({
    where,
    orderBy: [{ sortName: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    include: {
      owner: { select: { name: true, twentyMemberId: true } }, pod: { select: { name: true } },
      enrollments: { where: { status: { in: ['ACTIVE', 'PAUSED'] } }, include: { campaign: { select: { id: true, name: true } } }, take: 1 },
      nextActions: { where: { state: 'OPEN', personId: null }, take: 1 },
      touches: { orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
      _count: { select: { calls: true } },
    },
  });
  const rows: ContactRow[] = all.map((c) => {
    const r = checkReady(c, { owner: c.owner, podName: c.pod?.name ?? null, settings: settings.sandbox });
    const na = c.nextActions[0];
    return {
      id: c.id, name: `${c.firstName} ${c.lastName}`.trim() || 'Removed contact', title: c.jobTitle, firm: c.companyName, owner: c.owner?.name ?? null, ownerId: c.ownerId, podId: c.podId,
      ready: r.ready, readyText: readyLabel(r), campaign: c.enrollments[0]?.campaign ?? null,
      nextAction: na ? `${na.label} · ${formatLocalDate(na.dueDate)}` : null,
      lastTouch: c.touches[0] ? formatLocalDate(toLocalDate(c.touches[0].occurredAt, workspaceTimezone())) : null,
      calls: c._count.calls, source: `${c.source === 'BELLWETHER' ? 'Bellwether' : c.source === 'MANUAL' ? 'Added' : c.source === 'CSV' ? 'CSV' : 'Call'} · ${formatLocalDate(toLocalDate(c.createdAt, workspaceTimezone()))}`,
      status: c.status, twentyPersonId: c.twentyPersonId, movedAt: c.movedAt,
    };
  });
  const filtered = f.ready === 'ready' ? rows.filter((r) => r.ready) : f.ready === 'not_ready' ? rows.filter((r) => !r.ready) : rows;
  const pages = Math.max(1, Math.ceil(filtered.length / SANDBOX_PAGE));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: filtered.slice((p - 1) * SANDBOX_PAGE, p * SANDBOX_PAGE), total: filtered.length, pages };
}
