import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { addDays, isLocalDate, todayIn, type LocalDate } from '../dates';
import { getSettings } from '../settings';
import { needsPod, canApproveCampaign, canCreateCampaign, type Actor } from '../auth/rbac';
import { nextWorkingDay } from '../engine/clock';
import { OCCUPYING_STATUSES } from '../engine/enrollment';
import { advanceEnrollment, type EngineContext } from '../engine/tasks';
import { workspaceTimezone } from '../workspace';
import { checkKeysOf, suppressedHashes, suppressionHash } from './suppression';
import { crmDoNotContactTwin } from './dedupe';
import { canAct, type GuardActor } from '../outreach/guard';

/**
 * Sandbox campaigns on the existing engine (decision 1): a Campaign with audience SANDBOX whose
 * personIds are sandbox contact ids; its enrollments, tasks and next actions point at the contact.
 * Owner first, as for CRM people: the contact's owner works it; an unclaimed contact goes to the
 * least-loaded FO of the pod, who then owns it. Nothing is written to Twenty.
 */

export type SandboxAudienceIssue = { id: string; name: string; reason: string };

/**
 * Who cannot be in this campaign, and why, in one phrase each (the studio's whoAndWhy rule). With
 * `actor`, the guard's ownership rule applies to each contact (B132): a Junior FO adds only their own.
 * Every key counts for suppression, every phone of every type included (B001), and a contact whose
 * name and firm are Do not contact in the CRM is left out (N003).
 */
export async function sandboxAudienceIssues(contactIds: string[], podId: string, excludeCampaignId?: string, actor?: GuardActor | null): Promise<{ eligible: string[]; issues: SandboxAudienceIssue[] }> {
  const contacts = await prisma.sandboxContact.findMany({ where: { id: { in: contactIds } }, include: { owner: { select: { name: true, active: true } }, pod: { select: { name: true } } } });
  const busy = new Set((await prisma.enrollment.findMany({ where: { sandboxContactId: { in: contactIds }, personId: null, status: { in: OCCUPYING_STATUSES } }, select: { sandboxContactId: true } })).map((e) => e.sandboxContactId));
  const promised = new Map<string, string>();
  for (const c of await prisma.campaign.findMany({ where: { audience: 'SANDBOX', status: { in: ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'] }, personIds: { hasSome: contactIds }, ...(excludeCampaignId ? { id: { not: excludeCampaignId } } : {}) }, select: { name: true, personIds: true } })) for (const id of c.personIds) promised.set(id, c.name);
  const podFos = new Set((await prisma.userPod.findMany({ where: { podId, user: { active: true } }, select: { userId: true } })).map((u) => u.userId));
  const keysOf = new Map(contacts.map((c) => [c.id, checkKeysOf(c, c.id)]));
  const hashes = await suppressedHashes([...keysOf.values()].flat());
  const eligible: string[] = [];
  const issues: SandboxAudienceIssue[] = [];
  for (const id of contactIds) {
    const c = contacts.find((x) => x.id === id);
    if (!c) { issues.push({ id, name: 'Someone', reason: 'No longer in the sandbox' }); continue; }
    const name = `${c.firstName} ${c.lastName}`.trim() || 'Someone';
    if (c.status === 'MOVED') { issues.push({ id, name, reason: 'Moved to the CRM' }); continue; }
    if (c.status !== 'ACTIVE') { issues.push({ id, name, reason: c.status === 'OPTED_OUT' ? 'Opted out' : 'Removed' }); continue; }
    if (c.crmMatchPersonId) { issues.push({ id, name, reason: 'Also in the CRM' }); continue; }
    if ((keysOf.get(c.id) ?? []).some((k) => hashes.has(suppressionHash(k.kind, k.value)))) { issues.push({ id, name, reason: 'On the suppression list' }); continue; }
    if (await crmDoNotContactTwin(c)) { issues.push({ id, name, reason: 'Do not contact in the CRM' }); continue; }
    if (actor) {
      const verdict = canAct(actor, { kind: 'cold', id: c.id, status: c.status, name, ownerId: c.ownerId, ownerName: c.owner?.name ?? null, ownerActive: c.owner?.active ?? false, podId: c.podId, podName: c.pod?.name ?? null, twentyPersonId: c.twentyPersonId, movedById: c.movedById, optedOutAt: c.optedOutAt, optOutSource: c.optOutSource, crmMatchPersonId: c.crmMatchPersonId, crmAutoPersonId: c.crmAutoPersonId, moving: false }, 'enroll');
      if (!verdict.ok) { issues.push({ id, name, reason: verdict.reason.replace(/\.$/, '') }); continue; }
    }
    if (busy.has(id)) { issues.push({ id, name, reason: 'Already in a sandbox campaign' }); continue; }
    if (promised.has(id)) { issues.push({ id, name, reason: `Already in ${promised.get(id)}` }); continue; }
    if (c.ownerId && !podFos.has(c.ownerId)) { issues.push({ id, name, reason: 'Owned by someone outside this pod' }); continue; }
    eligible.push(id);
  }
  return { eligible, issues };
}

/** "Jane Doe and Sam Lee: Opted out; Ann Roe: Moved to the CRM" - a reason is never repeated per person. */
export function whoAndWhySandbox(issues: SandboxAudienceIssue[]): string {
  const byReason = new Map<string, string[]>();
  for (const i of issues) byReason.set(i.reason, [...(byReason.get(i.reason) ?? []), i.name]);
  const names = (list: string[]) => (list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]);
  return [...byReason.entries()].map(([reason, list]) => `${names(list)}: ${reason}`).join('; ');
}

export type CreateSandboxCampaignInput = { name: string; sequenceId: string; podId: string; startDate: LocalDate; contactIds: string[]; startsPerFoPerDay?: number | null };

export async function createSandboxCampaign(input: CreateSandboxCampaignInput, actor: Actor, audit: AuditActor): Promise<{ ok: true; id: string; left: string | null } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name the campaign.' };
  if (!isLocalDate(input.startDate)) return { ok: false, error: 'Pick a start date.' };
  if (input.startDate < todayIn(workspaceTimezone())) return { ok: false, error: 'The start date is in the past.' };
  if (!canCreateCampaign(actor, input.podId)) return { ok: false, error: 'You can start campaigns only for the pods you are in.' };
  const sequence = await prisma.sequence.findFirst({ where: { id: input.sequenceId, archived: false } });
  if (!sequence) return { ok: false, error: 'Choose a sequence.' };
  const { eligible, issues } = await sandboxAudienceIssues([...new Set(input.contactIds)], input.podId, undefined, actor);
  if (!eligible.length) return { ok: false, error: issues.length ? `Nobody can be in it. ${whoAndWhySandbox(issues)}.` : 'Select contacts first.' };
  const approved = canApproveCampaign(actor, input.podId);
  const campaign = await prisma.campaign.create({
    data: { name: name.slice(0, 200), audience: 'SANDBOX', sequenceId: sequence.id, podId: input.podId, personIds: eligible, startDate: input.startDate, startsPerFoPerDay: input.startsPerFoPerDay ?? null, assignmentMode: 'OWNER', status: approved ? 'SCHEDULED' : 'PENDING_APPROVAL', approvedAt: approved ? new Date() : null, approvedById: approved ? actor.id : null, createdById: actor.id, sourceType: 'IDS', sourceRef: 'Sandbox' },
  });
  await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'created', actor: audit, details: { audience: 'SANDBOX', people: eligible.length, left: issues.length } });
  return { ok: true, id: campaign.id, left: issues.length ? whoAndWhySandbox(issues) : null };
}

/** Launch on the start day: owner-first enrollments, paced per FO, then each one's first step. */
export async function activateSandboxCampaign(id: string, ctx: EngineContext): Promise<{ enrolled: number; skipped: number }> {
  const now = ctx.now ?? new Date();
  const settings = await getSettings();
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id }, include: { sequence: true, pod: { include: { users: { include: { user: true } } } } } });
  if (campaign.pod.archived || campaign.sequence.archived) throw new Error(campaign.pod.archived ? `Not started: ${campaign.pod.name} has been archived.` : `Not started: its sequence, ${campaign.sequence.name}, has been archived.`);
  const fos = campaign.pod.users.map((u) => u.user).filter((u) => u.active && needsPod(u.role));
  if (!fos.length) throw new Error(`Not started: nobody in ${campaign.pod.name} runs outreach.`);
  const { eligible } = await sandboxAudienceIssues(campaign.personIds, campaign.podId, id);
  const contacts = await prisma.sandboxContact.findMany({ where: { id: { in: eligible } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const rate = Math.max(1, campaign.startsPerFoPerDay ?? settings.rules.defaultDailyRampPerFo);
  const load = new Map<string, number>(fos.map((f) => [f.id, 0]));
  const start = nextWorkingDay(campaign.startDate, settings.rules.workingDays);
  const created = await prisma.$transaction(async (tx) => {
    const rows: { id: string }[] = [];
    for (const c of contacts) {
      const owner = c.ownerId && load.has(c.ownerId) ? c.ownerId : [...load.entries()].sort((a, b) => a[1] - b[1])[0][0];
      const k = load.get(owner) ?? 0;
      load.set(owner, k + 1);
      let day = start;
      for (let i = 0; i < Math.floor(k / rate); i++) day = nextWorkingDay(addDays(day, 1), settings.rules.workingDays);
      if (!c.ownerId) await tx.sandboxContact.update({ where: { id: c.id }, data: { ownerId: owner, podId: campaign.podId, claimedAt: now, firstClaimedAt: c.firstClaimedAt ?? now } });
      const e = await tx.enrollment.create({ data: { sandboxContactId: c.id, foUserId: owner, podId: campaign.podId, campaignId: id, campaignRun: campaign.runNumber, sequenceId: campaign.sequenceId, startDate: day, status: 'ACTIVE', createdById: ctx.actor.type === 'USER' ? ctx.actor.id ?? null : null, createdAt: now, audience: 'SANDBOX' } });
      rows.push(e);
    }
    await tx.campaign.update({ where: { id }, data: { status: 'ACTIVE' } });
    await logAudit({ entityType: 'campaign', entityId: id, action: 'started', actor: ctx.actor, details: { run: campaign.runNumber, enrolled: rows.length, skipped: campaign.personIds.length - rows.length, audience: 'SANDBOX' } }, tx);
    return rows;
  }, { timeout: 60_000 });
  for (const e of created) await advanceEnrollment(e.id, ctx);
  return { enrolled: created.length, skipped: campaign.personIds.length - created.length };
}

/** Add more contacts to a sandbox campaign that has not started. */
export async function addToSandboxCampaign(campaignId: string, contactIds: string[], audit: AuditActor, actor: GuardActor | null = null): Promise<{ ok: true; added: number; left: string | null } | { ok: false; error: string }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.audience !== 'SANDBOX') return { ok: false, error: 'Campaign not found.' };
  if (!['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'].includes(campaign.status)) return { ok: false, error: 'This campaign has started; add these contacts to a new one.' };
  const fresh = contactIds.filter((id) => !campaign.personIds.includes(id));
  const { eligible, issues } = await sandboxAudienceIssues(fresh, campaign.podId, campaignId, actor);
  if (eligible.length) await prisma.campaign.update({ where: { id: campaignId }, data: { personIds: [...campaign.personIds, ...eligible] } });
  await logAudit({ entityType: 'campaign', entityId: campaignId, action: 'people_added', actor: audit, details: { added: eligible.length } });
  return { ok: true, added: eligible.length, left: issues.length ? whoAndWhySandbox(issues) : null };
}
