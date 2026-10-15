import { prisma, type Tx } from './db';
import { ROLES_NEEDING_POD } from './auth/rbac';
import { externalPeopleWhere } from './internal-organizations';
import { cachedPersonName } from './person-cache';

export type AudienceIssueKind = 'deleted' | 'dnd' | 'optedOut' | 'blocked' | 'internal' | 'busy' | 'owner' | 'outside';
/** Someone who cannot be in this campaign, and the one reason that decides it. `ownerId` is set when their owner is an FO of this pod who could run them. */
export type AudienceIssue = { id: string; name: string; company: string | null; kind: AudienceIssueKind; reason: string; ownerId?: string };
/** `anyPod`: whoever is choosing may take contacts from any pod (canAddFromAnyPod). */
export type AudienceContext = { podId: string; podOwnerValue: string; podName: string; ownerMemberIds: string[]; campaignId?: string; checkOwners: boolean; anyPod?: boolean };

/** "the Alisa pod", but a pod named the way Twenty labels it ("Alisa's pod") is not called a pod twice. */
const podLabel = (name: string) => (/\bpod\b/i.test(name) ? name : `the ${name} pod`);

/**
 * Everyone a campaign already holds: its people, its draft and the request behind its plan. They
 * stay eligible whoever plans it next, so a Pod Manager's picks from another pod survive an edit by
 * someone who could not have made them.
 */
export async function campaignMembers(campaignId: string, db: Tx = prisma): Promise<Set<string>> {
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { personIds: true, plannerDraft: true } });
  const draft = c?.plannerDraft as { personIds?: string[]; request?: { personIds?: string[] } } | null;
  return new Set([...(c?.personIds ?? []), ...(draft?.personIds ?? []), ...(draft?.request?.personIds ?? [])]);
}

/** One eligibility check for the picker, bulk selection, planning and publication. */
export async function campaignAudienceIssues(ids: string[], context?: AudienceContext, db: Tx = prisma): Promise<AudienceIssue[]> {
  if (!ids.length) return [];
  const [people, external, blocked, campaigns, enrollments, kept] = await Promise.all([
    db.personCache.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, email: true, companyName: true, companyId: true, deletedAt: true, dnd: true, optedOut: true, podOwner: true, ownerMemberId: true } }),
    db.personCache.findMany({ where: { id: { in: ids }, AND: [await externalPeopleWhere()] }, select: { id: true } }),
    db.blockedAccount.findMany({ select: { companyId: true } }),
    db.campaign.findMany({ where: { ...(context?.campaignId ? { id: { not: context.campaignId } } : {}), status: { in: ['SCHEDULED', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED'] }, personIds: { hasSome: ids } }, select: { name: true, personIds: true } }),
    db.enrollment.findMany({ where: { personId: { in: ids }, status: { in: ['ACTIVE', 'PAUSED'] }, ...(context?.campaignId ? { OR: [{ campaignId: null }, { campaignId: { not: context.campaignId } }] } : {}) }, select: { personId: true, campaign: { select: { name: true } } } }),
    context?.campaignId && !context.anyPod ? campaignMembers(context.campaignId, db) : Promise.resolve(new Set<string>()),
  ]);
  // From another pod, the owner decides even before the team is chosen: whoever owns them must be able to run this pod's campaign.
  const ownerIds = [...new Set(people.flatMap(p => p.ownerMemberId && context && !context.ownerMemberIds.includes(p.ownerMemberId) && (context.checkOwners || p.podOwner !== context.podOwnerValue) ? [p.ownerMemberId] : []))];
  const owners = ownerIds.length ? await db.user.findMany({ where: { twentyMemberId: { in: ownerIds } }, select: { id: true, name: true, twentyMemberId: true, active: true, role: true, pods: { select: { podId: true, pod: { select: { name: true } } } } } }) : [];
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
    const owner = p.ownerMemberId && !ownedHere ? ownerOf.get(p.ownerMemberId) : undefined;
    const fo = !!owner?.active && ROLES_NEEDING_POD.includes(owner.role);
    const runsHere = fo && owner!.pods.some(x => x.podId === context.podId);
    const elsewhere = fo && !runsHere ? owner!.pods.map(x => podLabel(x.pod.name)) : [];
    const ownedBy = () => issue('owner', !owner ? 'Owner is not a Cadence user' : elsewhere.length ? `Owned by ${owner.name} in ${elsewhere.length === 1 ? elsewhere[0] : `${elsewhere.slice(0, -1).join(', ')} and ${elsewhere.at(-1)}`}` : `Owned by ${owner.name}`, runsHere ? owner!.id : undefined);
    if (context.checkOwners && p.ownerMemberId && !ownedHere) return ownedBy();
    if (!ownedHere && p.podOwner !== context.podOwnerValue) {
      if (!context.anyPod && !kept.has(id)) return issue('outside', `Not in ${podLabel(context.podName)}`);
      if (p.ownerMemberId && !runsHere) return ownedBy();
    }
    return [];
  });
}
