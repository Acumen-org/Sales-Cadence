import { prisma, type Tx } from './db';
import { ROLES_NEEDING_POD } from './auth/rbac';
import { externalPeopleWhere } from './internal-organizations';
import { cachedPersonName } from './person-cache';

export type AudienceIssueKind = 'deleted' | 'dnd' | 'optedOut' | 'blocked' | 'internal' | 'busy' | 'owner' | 'outside';
/** Someone who cannot be in this campaign, and the one reason that decides it. `ownerId` is set when their owner is an FO of this pod who could run them. */
export type AudienceIssue = { id: string; name: string; company: string | null; kind: AudienceIssueKind; reason: string; ownerId?: string };
/** `anyPod`: whoever is choosing may take contacts from any pod (canAddFromAnyPod). `joining`: the FO being added to a running campaign, whose people these are meant to be. */
export type AudienceContext = { podId: string; podOwnerValue: string; podName: string; ownerMemberIds: string[]; campaignId?: string; checkOwners: boolean; anyPod?: boolean; joining?: string };

/** "the Alisa pod", but a pod named the way Twenty labels it ("Alisa's pod") is not called a pod twice. */
export const podLabel = (name: string) => (/\bpod\b/i.test(name) ? name : `the ${name} pod`);

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
    db.enrollment.findMany({ where: { personId: { in: ids }, status: { in: ['ACTIVE', 'PAUSED'] }, ...(context?.campaignId ? { OR: [{ campaignId: null }, { campaignId: { not: context.campaignId } }] } : {}) }, select: { personId: true, campaign: { select: { name: true } }, sequence: { select: { name: true } } } }),
    context?.campaignId && !context.anyPod ? campaignMembers(context.campaignId, db) : Promise.resolve(new Set<string>()),
  ]);
  // From another pod, the owner decides even before the team is chosen: whoever owns them must be able to run this pod's campaign.
  const ownerIds = [...new Set(people.flatMap(p => p.ownerMemberId && context && !context.ownerMemberIds.includes(p.ownerMemberId) && (context.checkOwners || p.podOwner !== context.podOwnerValue) ? [p.ownerMemberId] : []))];
  const [owners, pods] = await Promise.all([
    ownerIds.length ? db.user.findMany({ where: { twentyMemberId: { in: ownerIds } }, select: { id: true, name: true, twentyMemberId: true, active: true, role: true, pods: { select: { podId: true, pod: { select: { name: true } } } } } }) : [],
    context && people.some(p => p.podOwner !== context.podOwnerValue) ? db.pod.findMany({ select: { podOwnerValue: true, name: true } }) : [],
  ]);
  const ownerOf = new Map(owners.map(o => [o.twentyMemberId!, o]));
  const podNamed = new Map(pods.map(p => [p.podOwnerValue, p.name]));
  const byId = new Map(people.map(p => [p.id, p]));
  const externalIds = new Set(external.map(p => p.id));
  const blockedIds = new Set(blocked.map(b => b.companyId));
  const occupied = new Map<string, string>();
  for (const c of campaigns) for (const id of c.personIds) occupied.set(id, c.name);
  for (const e of enrollments) occupied.set(e.personId, e.campaign?.name ?? `the ${e.sequence.name} sequence`);
  return ids.flatMap((id): AudienceIssue[] => {
    const p = byId.get(id);
    const issue = (kind: AudienceIssueKind, reason: string, ownerId?: string): AudienceIssue[] => [{ id, name: p ? cachedPersonName(p) : 'Unknown contact', company: p?.companyName ?? null, kind, reason, ...(ownerId ? { ownerId } : {}) }];
    // Each reason is one plain clause that says why, so it reads on its own in a list of names.
    if (!p || p.deletedAt) return issue('deleted', 'Deleted in Twenty');
    if (p.dnd) return issue('dnd', 'Marked Do not contact in Twenty');
    if (p.optedOut) return issue('optedOut', 'Asked not to be contacted');
    if (p.companyId && blockedIds.has(p.companyId)) return issue('blocked', 'Their company is blocked, and only an admin can unblock it');
    if (!externalIds.has(id)) return issue('internal', 'Works at one of our own companies');
    if (occupied.has(id)) return issue('busy', `Already in ${occupied.get(id)}`);
    if (!context) return [];
    const ownedHere = !!p.ownerMemberId && context.ownerMemberIds.includes(p.ownerMemberId);
    const owner = p.ownerMemberId && !ownedHere ? ownerOf.get(p.ownerMemberId) : undefined;
    const fo = !!owner?.active && ROLES_NEEDING_POD.includes(owner.role);
    const runsHere = fo && owner!.pods.some(x => x.podId === context.podId);
    const elsewhere = fo && !runsHere ? owner!.pods.map(x => podLabel(x.pod.name)) : [];
    const ownedBy = () => issue('owner',
      !owner ? 'Their owner in Twenty is not a Cadence user'
        : !owner.active ? `Owned by ${owner.name}, who no longer has access to Cadence`
        : !fo ? `Owned by ${owner.name}, who does not run outreach`
        : runsHere ? context.joining ? `Owned by ${owner.name}, not ${context.joining}` : `Owned by ${owner.name}, who is not on this campaign`
        : elsewhere.length ? `Owned by ${owner.name} in another pod (${and(elsewhere)})`
        : `Owned by ${owner.name}, who is not in any pod`,
      runsHere ? owner!.id : undefined);
    if (context.checkOwners && p.ownerMemberId && !ownedHere) return ownedBy();
    if (!ownedHere && p.podOwner !== context.podOwnerValue) {
      if (!context.anyPod && !kept.has(id)) return issue('outside', `${p.podOwner ? `In ${podLabel(podNamed.get(p.podOwner) ?? p.podOwner)}` : 'In no pod in Twenty'}, so only a Pod Manager or admin can add them`);
      if (p.ownerMemberId && !runsHere) return ownedBy();
    }
    return [];
  });
}

/** "A", "A and B", "A, B and C". */
const and = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * Who could not be included and why, each reason once with the people it stops (owner, 24
 * September 2026: never one sentence per person): "Jane Doe and Bob Smith (marked Do not contact
 * in Twenty); Karl Lee (already in Spring push)". Long lists name two and count the rest.
 */
export function whoAndWhy(items: { name: string; reason: string }[]): string {
  const groups = new Map<string, string[]>();
  for (const i of items) groups.set(i.reason, [...(groups.get(i.reason) ?? []), i.name]);
  return [...groups].map(([reason, names]) => `${names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} others` : and(names)} (${reason.charAt(0).toLowerCase()}${reason.slice(1)})`).join('; ');
}
