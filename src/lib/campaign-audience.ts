import { prisma, type Tx } from './db';
import { ROLES_NEEDING_POD } from './auth/rbac';
import { externalPeopleWhere } from './internal-organizations';
import { cachedPersonName } from './person-cache';

export type AudienceIssueKind = 'deleted' | 'dnd' | 'optedOut' | 'blocked' | 'internal' | 'busy' | 'owner' | 'outside';
/** Someone who cannot be in this campaign, and the one reason that decides it. `ownerId` is set when their owner is an FO of this pod who could run them. */
export type AudienceIssue = { id: string; name: string; company: string | null; kind: AudienceIssueKind; reason: string; ownerId?: string };
export type AudienceContext = { podId: string; podOwnerValue: string; podName: string; ownerMemberIds: string[]; campaignId?: string; checkOwners: boolean };

/** One eligibility check for the picker, bulk selection, planning and publication. */
export async function campaignAudienceIssues(ids: string[], context?: AudienceContext, db: Tx = prisma): Promise<AudienceIssue[]> {
  if (!ids.length) return [];
  const [people, external, blocked, campaigns, enrollments] = await Promise.all([
    db.personCache.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, email: true, companyName: true, companyId: true, deletedAt: true, dnd: true, optedOut: true, podOwner: true, ownerMemberId: true } }),
    db.personCache.findMany({ where: { id: { in: ids }, AND: [await externalPeopleWhere()] }, select: { id: true } }),
    db.blockedAccount.findMany({ select: { companyId: true } }),
    db.campaign.findMany({ where: { ...(context?.campaignId ? { id: { not: context.campaignId } } : {}), status: { in: ['SCHEDULED', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED'] }, personIds: { hasSome: ids } }, select: { name: true, personIds: true } }),
    db.enrollment.findMany({ where: { personId: { in: ids }, status: { in: ['ACTIVE', 'PAUSED'] }, ...(context?.campaignId ? { OR: [{ campaignId: null }, { campaignId: { not: context.campaignId } }] } : {}) }, select: { personId: true, campaign: { select: { name: true } } } }),
  ]);
  const ownerIds = [...new Set(people.flatMap(p => p.ownerMemberId && context?.checkOwners && !context.ownerMemberIds.includes(p.ownerMemberId) ? [p.ownerMemberId] : []))];
  const owners = ownerIds.length ? await db.user.findMany({ where: { twentyMemberId: { in: ownerIds } }, select: { id: true, name: true, twentyMemberId: true, active: true, role: true, pods: { select: { podId: true } } } }) : [];
  const ownerOf = new Map(owners.map(o => [o.twentyMemberId!, o]));
  const byId = new Map(people.map(p => [p.id, p]));
  const externalIds = new Set(external.map(p => p.id));
  const blockedIds = new Set(blocked.map(b => b.companyId));
  const occupied = new Map<string, string>();
  for (const c of campaigns) for (const id of c.personIds) occupied.set(id, c.name);
  for (const e of enrollments) occupied.set(e.personId, e.campaign?.name ?? 'another sequence');
  return ids.flatMap((id): AudienceIssue[] => {
    const p = byId.get(id);
    const issue = (kind: AudienceIssueKind, reason: string, ownerId?: string): AudienceIssue[] => [{ id, name: p ? cachedPersonName(p) : 'Unknown contact', company: p?.companyName ?? null, kind, reason, ...(ownerId ? { ownerId } : {}) }];
    if (!p || p.deletedAt) return issue('deleted', 'No longer in Twenty');
    if (p.dnd) return issue('dnd', 'Do not contact');
    if (p.optedOut) return issue('optedOut', 'Opted out');
    if (p.companyId && blockedIds.has(p.companyId)) return issue('blocked', 'Blocked account');
    if (!externalIds.has(id)) return issue('internal', 'Internal contact');
    if (occupied.has(id)) return issue('busy', `Already in ${occupied.get(id)}`);
    if (!context) return [];
    const ownedHere = !!p.ownerMemberId && context.ownerMemberIds.includes(p.ownerMemberId);
    if (context.checkOwners && p.ownerMemberId && !ownedHere) {
      const owner = ownerOf.get(p.ownerMemberId);
      const runsHere = owner?.active && ROLES_NEEDING_POD.includes(owner.role) && owner.pods.some(x => x.podId === context.podId);
      return issue('owner', owner ? `Owned by ${owner.name}` : 'Owner is not a Cadence user', runsHere ? owner!.id : undefined);
    }
    if (!ownedHere && p.podOwner !== context.podOwnerValue) return issue('outside', `Not in ${/\bpod$/i.test(context.podName) ? context.podName : `the ${context.podName} pod`}`);
    return [];
  });
}
