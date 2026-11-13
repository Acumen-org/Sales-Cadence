import type { SessionUser } from '@/lib/auth/current-user';
import { isBizOps, toActor } from '@/lib/auth/rbac';
import { assignableOwners } from '@/lib/outreach/ownership';
import { refOf, subjectHref } from '@/lib/subject';
import { accountViews, needsOwnerItems } from '@/lib/linkedin/tasks-view';
import { followUpSubject, followUpWhy } from '@/components/tasks/linkedin-follow-ups';
import { LinkedInNeedsOwner } from './needs-owner';

/** Cold outreach: cold contacts who answered and have no owner, for whoever may take or give them (owner, 13 Nov 2026: Cold outreach only). */
export async function LinkedInNeedsOwnerSection({ user, scope = 'cold' }: { user: SessionUser; /** crm: the rare CRM person with nobody to give it to, for admins on Tasks. */ scope?: 'cold' | 'crm' }) {
  if (isBizOps(toActor(user))) return null;
  const items = await needsOwnerItems(user, 100, scope);
  if (!items.length) return null;
  const [owners, accounts] = await Promise.all([assignableOwners(user), accountViews(items.flatMap((f) => (f.accountId ? [f.accountId] : [])))]);
  const rows = items.map((f) => {
    const { name, who } = followUpSubject(f);
    const ref = refOf(f);
    return { id: f.id, name, href: ref ? subjectHref(ref) : null, why: followUpWhy(f, user.timezone), account: f.accountId ? accounts.get(f.accountId)?.name ?? f.accountId : null, company: who?.companyName ?? null, podIds: f.sandboxContact?.podId ? [f.sandboxContact.podId] : [] };
  });
  return <LinkedInNeedsOwner rows={rows} owners={owners} canTake />;
}
