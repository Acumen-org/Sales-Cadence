import type { SessionUser } from '@/lib/auth/current-user';
import { isBizOps, toActor } from '@/lib/auth/rbac';
import { assignableOwners } from '@/lib/outreach/ownership';
import { refOf, subjectHref } from '@/lib/subject';
import { accountViews, needsOwnerItems } from '@/lib/linkedin/tasks-view';
import { followUpSubject, followUpWhy } from '@/components/tasks/linkedin-follow-ups';
import { LinkedInNeedsOwner } from './needs-owner';

/** Tasks and Cold outreach: people who answered on LinkedIn and need an owner, for whoever may take or give them. */
export async function LinkedInNeedsOwnerSection({ user }: { user: SessionUser }) {
  if (isBizOps(toActor(user))) return null;
  const items = await needsOwnerItems(user);
  if (!items.length) return null;
  const [owners, accounts] = await Promise.all([assignableOwners(user), accountViews(items.map((f) => f.accountId))]);
  const rows = items.map((f) => {
    const { name, who } = followUpSubject(f);
    const ref = refOf(f);
    return { id: f.id, name, href: ref ? subjectHref(ref) : null, why: followUpWhy(f, user.timezone), account: accounts.get(f.accountId)?.name ?? f.accountId, company: who?.companyName ?? null, podIds: f.sandboxContact?.podId ? [f.sandboxContact.podId] : [] };
  });
  return <LinkedInNeedsOwner rows={rows} owners={owners} canTake />;
}
