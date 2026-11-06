import type { Campaign } from '@prisma/client';
import type { CampaignDraft } from '@/lib/campaign-planner';
import type { PublishedCalendar } from '@/lib/campaign-planning-service';
import { whoAndWhy } from '@/lib/campaign-audience';
import type { ContactChannel } from '@/lib/outreach/contactability';
import { coldAudienceIssues, coldAudienceWarnings, draftChannels, leftAtLaunch } from '@/lib/sandbox/campaigns';
import { formatInstant, formatLocalDate, todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';

type Line = { tone: 'amber' | 'gray'; title: string; text: string };

/** "Jane Doe", "Jane Doe and Sam Lee", "Jane Doe, Sam Lee and 4 others". */
const names = (list: string[]) => (list.length > 3 ? `${list.slice(0, 2).join(', ')} and ${list.length - 2} others` : list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '');

/**
 * What a cold campaign's page says beyond the CRM page (PLAN 4.4): who publishing left out and why,
 * stored so it survives the redirect (B047); who launch left out, by name (N021); before it starts,
 * who would be left out now (B144) and who still has a call waiting for its form (N070), with the
 * steps a missing email or phone will skip (B136); and a start date that has passed (N019).
 */
export async function ColdCampaignNotes({ campaign, launched, timezone }: { campaign: Campaign & { pod: { name: string } }; launched: boolean; timezone: string }) {
  const plan = campaign.publishedPlan as unknown as PublishedCalendar | null;
  const draft = campaign.plannerDraft as unknown as CampaignDraft | null;
  const today = todayIn(workspaceTimezone());
  const lines: Line[] = [];
  if (!launched && plan?.cold?.leftOut.length) lines.push({ tone: 'gray', title: `Left out when it was published (${plan.cold.leftOut.length})`, text: `${whoAndWhy(plan.cold.leftOut)}.` });
  const started = launched ? await leftAtLaunch(campaign.id) : null;
  if (started) lines.push({ tone: 'gray', title: `Left out when it started, ${formatInstant(started.at, timezone)} (${started.people.length})`, text: `${whoAndWhy(started.people)}. Nobody left out was contacted.` });
  if (!launched && ['DRAFT', 'SCHEDULED'].includes(campaign.status) && campaign.personIds.length) {
    const foIds = (plan?.fos ?? draft?.fos ?? []).map((f) => f.id);
    const now = await coldAudienceIssues(campaign.personIds, { podId: campaign.podId, podName: campaign.pod.name, foIds, campaignId: campaign.id, anyPod: true });
    if (now.length) lines.push({ tone: 'amber', title: `${now.length === 1 ? 'One contact' : `${now.length} contacts`} would be left out if it started now`, text: `${whoAndWhy(now)}. Launch checks everyone again and contacts nobody it leaves out.` });
    const channels: Set<ContactChannel> = draft ? draftChannels(draft.flows) : new Set();
    for (const w of await coldAudienceWarnings(campaign.personIds, channels)) lines.push({ tone: 'amber', title: w.reason, text: `${names(w.people.map((p) => p.name))}.` });
    if (campaign.status === 'SCHEDULED' && campaign.startDate < today) lines.push({ tone: 'amber', title: 'Start date has passed', text: `It was ${formatLocalDate(campaign.startDate, 'long')}. It starts today instead, and every date moves on with it: nothing is sent late.` });
  }
  if (!lines.length) return null;
  return <section className="space-y-2" aria-label="Before and at launch">
    {lines.map((l) => <div key={l.title} role={l.tone === 'amber' ? 'status' : undefined} className={`rounded-xl border p-4 text-sm ${l.tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-line bg-white text-ink-700'}`}><p className="font-medium text-ink-900">{l.title}</p><p className="mt-1">{l.text}</p></div>)}
  </section>;
}
