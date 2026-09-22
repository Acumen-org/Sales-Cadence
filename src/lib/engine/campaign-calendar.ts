import { prisma } from '../db';
import { lockAccounts } from '../account-lock';
import { logAudit } from '../audit';
import { todayIn } from '../dates';
import { workspaceTimezone } from '../workspace';
import { ROLES_NEEDING_POD } from '../auth/rbac';
import { externalPeopleWhere } from '../internal-organizations';
import { nonReplierCandidates } from '../campaigns-query';
import type { PublishedCalendar } from '../campaign-planning-service';
import type { EngineContext } from './tasks';
import { advanceEnrollment } from './tasks';

/** Execute the accepted calendar, never run a second allocator at launch. */
export async function activateCalendarCampaign(id: string, ctx: EngineContext) {
  const now = ctx.now ?? new Date();
  const initial = await prisma.campaign.findUniqueOrThrow({ where: { id } });
  const companies = await prisma.personCache.findMany({ where: { id: { in: initial.personIds } }, select: { companyId: true } });
  const external = await externalPeopleWhere();
  const followupIds = initial.followupSourceId ? new Set((await nonReplierCandidates(initial.followupSourceId, initial.followupWaitDays, now, initial.followupSourceRun ?? undefined)).map(e => e.personId)) : null;
  const created = await prisma.$transaction(async tx => {
    await lockAccounts(tx, companies.map(p => p.companyId));
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const c = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { pod: true } });
    if (c.status !== 'SCHEDULED' || c.startDate > todayIn(workspaceTimezone(), now)) return [];
    const plan = c.publishedPlan as unknown as PublishedCalendar | null;
    if (!plan?.valid || plan.version !== 1 || c.pod.archived) throw new Error('Review and publish a valid calendar before launching.');
    if (c.endDate && c.endDate < todayIn(workspaceTimezone(), now)) throw new Error('The campaign window has passed. Edit its dates and publish a new calendar.');
    const ids = plan.batches.flatMap(b => b.personIds);
    if (new Set(ids).size !== ids.length) throw new Error('The published audience contains duplicate people.');
    const people = await tx.personCache.findMany({ where: { id: { in: ids }, dnd: false, optedOut: false, deletedAt: null, AND: [external] } });
    const blockedAccounts = new Set((await tx.blockedAccount.findMany({ select: { companyId: true } })).map(b => b.companyId));
    const busy = await tx.enrollment.findMany({ where: { personId: { in: ids }, status: { in: ['ACTIVE', 'PAUSED'] } } });
    const eligible = new Map(people.filter(p => !p.companyId || !blockedAccounts.has(p.companyId)).map(p => [p.id, p]));
    const fos = await tx.user.findMany({ where: { id: { in: plan.fos.map(f => f.id) }, active: true, role: { in: ROLES_NEEDING_POD }, pods: { some: { podId: c.podId } } } });
    if (eligible.size !== ids.length || busy.length || fos.length !== plan.fos.length) throw new Error('The audience or team changed after publication. Review the campaign before it starts; no partial launch was made.');
    const originalOwners = new Map(plan.people.map(p => [p.id, p.ownerMemberId]));
    if (people.some(p => p.ownerMemberId !== originalOwners.get(p.id) || (followupIds && !followupIds.has(p.id))) || fos.some(f => f.twentyMemberId !== plan.fos.find(old => old.id === f.id)?.twentyMemberId)) throw new Error('Contact ownership or follow-up eligibility changed after publication. Review and republish the calendar before launching.');
    const rows = [];
    for (const b of plan.batches) {
      if (!plan.sequenceIds[b.flowId] || !b.dates.length) throw new Error('The published calendar is incomplete.');
      for (const personId of b.personIds) rows.push({
        personId, companyId: eligible.get(personId)!.companyId, campaignId: id, campaignRun: c.runNumber,
        foUserId: b.foId, podId: c.podId, sequenceId: plan.sequenceIds[b.flowId], startDate: b.dates[0], scheduleDates: b.dates,
        createdById: c.createdById, status: 'ACTIVE' as const,
      });
    }
    await tx.enrollment.createMany({ data: rows });
    await tx.campaign.update({ where: { id }, data: { status: 'ACTIVE' } });
    await logAudit({ entityType: 'campaign', entityId: id, action: 'started', actor: ctx.actor, details: { people: ids.length, batches: plan.batches.length, calendar: true } }, tx);
    return tx.enrollment.findMany({ where: { campaignId: id, campaignRun: c.runNumber }, select: { id: true } });
  }, { timeout: 60000 });
  for (const e of created) await advanceEnrollment(e.id, ctx);
  return { enrolled: created.length, skipped: 0 };
}
