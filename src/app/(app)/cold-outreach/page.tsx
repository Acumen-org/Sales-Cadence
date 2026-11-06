import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageFrame } from '@/components/page-frame';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin, isBizOps, isPodLeader, needsPod } from '@/lib/auth/rbac';
import { assignableOwners, needsNewOwner } from '@/lib/outreach/ownership';
import { getSettings } from '@/lib/settings';
import { todayIn } from '@/lib/dates';
import { listContacts, type ContactList } from '@/lib/sandbox/query';
import { listHref, shownOwner, viewHref, VIEW_LABELS, type ListSearch } from '@/lib/sandbox/list-view';
import { COLD_TASKS_HREF } from '@/lib/tasks-query';
import { EmptyState, Surface, Toolbar, ViewHeader } from '@/components/ui';
import { IconPeople, IconSearch } from '@/components/icons';
import { PeopleTable } from '@/components/people/people-table';
import { PeopleToolbar } from '@/components/people/people-toolbar';
import { NeedsNewOwner } from '@/components/sandbox/needs-new-owner';
import { ColdOutreachHeader } from '@/components/sandbox/section-tabs';
import { AddContactButton } from '@/components/sandbox/add-contact';
import { QuickViews } from '@/components/sandbox/quick-views';
import { RememberList } from '@/components/sandbox/list-link';
import { TaskFlash, flashTone } from '@/components/tasks/task-flash';

export const metadata = { title: 'Cold outreach' };

/**
 * Cold outreach (PLAN 4.1): contacts that are not in the CRM, worked here and moved to the CRM when
 * ready. The CRM's People table and toolbar with a cold variant: quick views with counts, one filter
 * row, one badge per contact, and a bulk bar that offers only what fits. Leaders work their pods'
 * Unclaimed and No next step views from here (4.8). Their work is in Tasks and on Home with
 * everyone's (D2); People stays CRM-only.
 */
export default async function ColdOutreachPage({ searchParams }: { searchParams: Promise<ListSearch> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const mayWork = !isBizOps(user) && (isAdmin(user) || needsPod(user.role));
  const looksAfterLeavers = isAdmin(user) || isPodLeader(user);
  const [list, owners, stranded, settings] = await Promise.all([
    listContacts(user, sp),
    // Assign offers the reps this reader may give contacts to (B119, B208).
    assignableOwners(user),
    looksAfterLeavers ? needsNewOwner(isAdmin(user) ? null : user.podIds) : Promise.resolve([]),
    getSettings(),
  ]);
  const { params, scope } = list;
  const myPods = list.pods.filter((p) => isAdmin(user) || user.podIds.includes(p.id));
  const flash = typeof sp.flash === 'string' && sp.flash ? sp.flash.slice(0, 300) : null;

  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <ColdOutreachHeader user={user} current="contacts" />
    {stranded.length ? <NeedsNewOwner stranded={stranded} owners={owners} /> : null}
    <Surface flush>
      <ViewHeader
        title={params.view === 'any' ? 'Search results' : VIEW_LABELS[params.view]}
        meta={`${list.total} result${list.total === 1 ? '' : 's'}`}
        actions={mayWork ? <AddContactButton pods={myPods} owns={needsPod(user.role)} /> : null}
      />
      <QuickViews tabs={list.tabs} current={params.view} />
      <Toolbar className="pt-3">
        <PeopleToolbar
          variant="cold"
          q={params.q}
          view={params.view}
          owner={shownOwner(params.view, scope)}
          pod={scope.pod}
          source={params.source}
          owners={list.owners}
          pods={list.pods}
          myPodIds={list.myPodIds}
          offersMine={list.role === 'rep' || list.role === 'leader'}
          offersNeedsOwner={looksAfterLeavers}
          chips={list.chips}
        />
      </Toolbar>
      {list.rows.length ? (
        // B056: another page or other filters start a fresh table, so a selection never reaches rows out of sight.
        <PeopleTable
          key={listHref(params, { page: String(list.page) })}
          variant="cold"
          rows={list.rows}
          canSelect={mayWork}
          bulk={{ owners, pods: myPods, today: todayIn(user.timezone), workingDays: settings.rules.workingDays }}
        />
      ) : <Empty list={list} action={emptyAction(list, mayWork, myPods, needsPod(user.role))} />}
      {list.pages > 1 ? <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[13px] text-ink-500">
        <span>Page <span className="font-medium text-ink-900">{list.page}</span> of <span className="font-medium text-ink-900">{list.pages}</span></span>
        <div className="flex gap-2">
          {list.page > 1 ? <Link href={listHref(params, { page: String(list.page - 1) })} className="btn-secondary btn-sm">Previous</Link> : null}
          {list.page < list.pages ? <Link href={listHref(params, { page: String(list.page + 1) })} className="btn-secondary btn-sm">Next</Link> : null}
        </div>
      </div> : null}
    </Surface>
    <RememberList />
    {flash ? <TaskFlash message={flash} tone={flashTone(sp.flashTone)} /> : null}
  </PageFrame>;
}

/** An empty list says why and which filter hides matches, each with a link that lifts it (N079, B153). */
function Empty({ list, action }: { list: ContactList; action: ReactNode }) {
  const empty = list.empty!;
  return <EmptyState
    icon={list.params.q ? <IconSearch size={20} /> : <IconPeople size={20} />}
    title={empty.title}
    hint={<>
      <p>{empty.hint}</p>
      {empty.hints.length ? <ul className="mt-2 space-y-1">{empty.hints.map((h) => <li key={h.href}>{h.words} <Link href={h.href} className="font-medium text-brand-700 hover:underline">{h.label}</Link></li>)}</ul> : null}
    </>}
    action={empty.hints.length ? null : action}
  />;
}

/** The next thing to do from an empty view. */
function emptyAction(list: ContactList, mayWork: boolean, pods: { id: string; name: string }[], owns: boolean): ReactNode {
  const link = (href: string, label: string) => <Link href={href} className="btn-secondary btn-sm">{label}</Link>;
  switch (list.params.view) {
    case 'mine': return mayWork ? link(viewHref(list.params, 'unclaimed'), 'See contacts to claim') : null;
    case 'no_next_step': case 'ready': case 'form_due': return link(COLD_TASKS_HREF, 'Open Tasks');
    case 'all': return mayWork && !list.params.q && !list.params.source ? <AddContactButton pods={pods} owns={owns} /> : null;
    case 'any': return null;
    default: return link(viewHref(list.params, 'all'), 'See all contacts');
  }
}

export const dynamic = 'force-dynamic';
