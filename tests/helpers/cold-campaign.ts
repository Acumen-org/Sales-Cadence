import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { addDays, todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { workingDay, type CampaignDraft } from '@/lib/campaign-planner';
import { previewCampaignCalendar, saveCampaignCalendar } from '@/lib/campaign-planning-service';

/** A signed-in user as the studio reads one, from a seeded user and their pods. */
export async function sessionOf(userId: string): Promise<SessionUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { pods: { include: { pod: true } } } });
  return { id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds: u.pods.map((p) => p.podId), pods: u.pods.map((p) => ({ id: p.podId, name: p.pod.name })) };
}

/** Today in the workspace, or the next working day when today is a weekend: a cold campaign's first possible start. */
export function firstWorkingDay(from = todayIn(workspaceTimezone())) {
  let d = from;
  while (!workingDay(d)) d = addDays(d, 1);
  return d;
}

/** Noon UTC on a day: a launch "now" that is that day in the workspace's zone. */
export const noonOf = (day: string) => new Date(`${day}T16:00:00Z`);

/** Two steps: an email and a call on day 1, an email on day 3. */
export const TWO_STEPS: CampaignDraft['flows'] = [{ id: 'default', name: 'Default', steps: [
  { id: 'first', day: 1, actions: [{ id: 'email', type: 'EMAIL', label: 'Email 1', template: 'Hi {{firstName}}' }, { id: 'call', type: 'CALL', label: 'Call 1' }] },
  { id: 'second', day: 3, actions: [{ id: 'email2', type: 'EMAIL', label: 'Email 2', template: 'Following up' }] },
] }];

export function coldDraft(podId: string, contactIds: string[], fos: string[], over: Partial<CampaignDraft> = {}): CampaignDraft {
  const startDate = over.startDate ?? firstWorkingDay();
  return { name: 'Cold Q4 Harbor', podId, startDate, endDate: addDays(startDate, 20), productInterest: ['PHH'], defaultBatchSize: 20, fos: fos.map((id) => ({ id, batchSize: 20 })), personIds: contactIds, assignments: {}, flows: TWO_STEPS, outreachEdited: true, ...over };
}

/** A cold campaign published in the studio, as the studio does it: review the plan, then publish its fingerprint. */
export async function publishColdCampaign(user: SessionUser, draft: CampaignDraft) {
  const review = await previewCampaignCalendar(draft, user, undefined, 'SANDBOX');
  if (!review.calendar.valid) throw new Error(`Plan not valid: ${review.calendar.issues.map((i) => i.title).join('; ')}; left out ${review.leftOut.map((l) => `${l.name} (${l.reason})`).join(', ')}`);
  const campaign = await saveCampaignCalendar(draft, user, { publish: true, fingerprint: review.fingerprint, audience: 'SANDBOX' });
  return { campaign, review };
}
