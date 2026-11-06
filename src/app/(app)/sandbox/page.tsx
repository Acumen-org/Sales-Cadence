import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { isAdmin, isBizOps, isPodLeader, needsPod } from '@/lib/auth/rbac';
import { assignableOwners, needsNewOwner } from '@/lib/outreach/ownership';
import { latestMoves, listMoves } from '@/lib/sandbox/moves-query';
import { NeedsNewOwner } from '@/components/sandbox/needs-new-owner';
import { prisma } from '@/lib/db';
import { formatInstant } from '@/lib/dates';
import { listContacts, type ContactFilters } from '@/lib/sandbox/query';
import { COLD_TASKS_HREF } from '@/lib/tasks-query';
import { COLD_CONTACT_BASE } from '@/lib/subject';
import { EmptyState, Surface, Toolbar, ViewHeader, Badge } from '@/components/ui';
import { ColdOutreachTabs } from '@/components/sandbox/section-tabs';
import { CampaignsScreen, type CampaignsSearch } from '@/components/campaigns/campaigns-screen';
import { ContactsTable } from '@/components/sandbox/contacts-table';
import { AddContactButton } from '@/components/sandbox/add-contact';

type Search = CampaignsSearch & { tab?: string; q?: string; owner?: string; status?: string; ready?: string; pod?: string; source?: string; page?: string; state?: string; mover?: string };

/**
 * The outreach sandbox (docs/outreach-sandbox-plan.md, section 5): contacts that are not in
 * the CRM, worked here and moved to the CRM when ready. Their work is in Tasks and on Home with
 * everyone's (D2); People stays CRM-only.
 */
export default async function SandboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  // The section's work is the Tasks screen, filtered to cold work (D2, B157): an old Work link lands there.
  if (sp.tab === 'work') redirect(COLD_TASKS_HREF);
  const tab = sp.tab === 'campaigns' || sp.tab === 'moves' ? sp.tab : 'contacts';
  const mayWork = !isBizOps(user) && (isAdmin(user) || needsPod(user.role));
  const href = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams(Object.entries({ tab, q: sp.q ?? '', owner: sp.owner ?? '', status: sp.status ?? '', ready: sp.ready ?? '', pod: sp.pod ?? '', source: sp.source ?? '' }).filter(([, v]) => v));
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') params.delete(k); else params.set(k, v); }
    return `/sandbox?${params.toString()}`;
  };
  // B208: the Owner filter lists sales reps only; Assign offers the reps this reader may give contacts to (B119).
  const [counts, pods, users, owners, stranded] = await Promise.all([
    prisma.sandboxContact.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.pod.findMany({ where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({ where: { active: true, role: { in: ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    assignableOwners(user),
    isAdmin(user) || isPodLeader(user) ? needsNewOwner(isAdmin(user) ? null : user.podIds) : Promise.resolve([]),
  ]);
  const active = counts.find((c) => c.status === 'ACTIVE')?._count._all ?? 0;

  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <Surface flush>
      <ViewHeader title="Sandbox" meta={<span className="tabular-nums text-ink-500">{active} in the sandbox</span>} actions={mayWork ? <AddContactButton pods={pods.filter((p) => isAdmin(user) || user.podIds.includes(p.id))} /> : null} />
      <ColdOutreachTabs current={tab} contactsHref={href({ tab: 'contacts', page: null })} />
    </Surface>
    {stranded.length ? <NeedsNewOwner stranded={stranded} owners={owners} /> : null}
    {tab === 'contacts' ? await ContactsTab() : tab === 'moves' ? await MovesTab() : await CampaignsTab()}
  </PageFrame>;

  async function ContactsTab() {
    // Lists open on the reader's own contacts, as every section opens on its reader's pod and name.
    const owner = sp.owner ?? (mayWork && !isAdmin(user) ? 'mine' : 'all');
    const filters: ContactFilters = { q: sp.q ?? '', owner, status: sp.status ?? 'active', ready: sp.ready ?? '', podId: sp.pod ?? '', source: sp.source ?? '' };
    const page = Math.max(1, Number(sp.page ?? 1) || 1);
    const { rows, total, pages } = await listContacts(filters, user.id, page);
    // Each row's latest move: Undo for whoever may (B106), a failure with its fix (B036), Moving.
    const moves = Object.fromEntries(await latestMoves(rows.map((r) => r.id), toActor(user)));
    return <Surface flush>
      <Toolbar className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <form action="/sandbox" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="tab" value="contacts" />
          <input name="q" defaultValue={sp.q ?? ''} placeholder="Search name, email, firm" aria-label="Search sandbox contacts" className="w-64" />
          <select name="owner" defaultValue={owner} aria-label="Owner"><option value="all">Everyone</option><option value="mine">Mine</option><option value="unclaimed">Unclaimed</option><option value="needs_owner">Needs a new owner</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <select name="status" defaultValue={filters.status} aria-label="Status"><option value="active">Active</option><option value="unclaimed">Unclaimed</option><option value="moved">Moved to CRM</option><option value="opted_out">Opted out</option><option value="removed">Removed</option></select>
          <select name="ready" defaultValue={filters.ready} aria-label="Ready to move"><option value="">Ready or not</option><option value="ready">Ready to move</option><option value="not_ready">Not ready</option></select>
          <select name="pod" defaultValue={filters.podId} aria-label="Pod"><option value="">All pods</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <select name="source" defaultValue={filters.source} aria-label="Source"><option value="">Any source</option><option value="BELLWETHER">Bellwether</option><option value="MANUAL">Added here</option><option value="CALL">From a call</option></select>
          <button type="submit" className="btn-secondary btn-sm">Apply</button>
        </form>
        <span className="ml-auto tabular-nums text-[13px] text-ink-500">{total}</span>
      </Toolbar>
      {rows.length ? <ContactsTable rows={rows} owners={owners} pods={pods.filter((p) => isAdmin(user) || user.podIds.includes(p.id))} mayWork={mayWork} moves={moves} /> : <EmptyState title={filters.status === 'active' && !sp.q ? 'No contacts in the sandbox yet' : 'No contacts match'} />}
      {pages > 1 ? <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-[13px]">{page > 1 ? <Link href={href({ page: String(page - 1) })} className="btn-ghost btn-sm">Previous</Link> : null}<span className="tabular-nums text-ink-500">{page} of {pages}</span>{page < pages ? <Link href={href({ page: String(page + 1) })} className="btn-ghost btn-sm">Next</Link> : null}</div> : null}
    </Surface>;
  }

  /** Moves to CRM (4.5): every move, newest first; failed ones stay visible (B036). */
  async function MovesTab() {
    const state = ['failed', 'running', 'undone'].includes(sp.state ?? '') ? sp.state! : '';
    const list = await listMoves({ state: state || null, moverId: sp.mover || null });
    const movers = [...new Map(list.map((m) => [m.moverId, m.moverName])).entries()];
    return <Surface flush>
      <Toolbar className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <form action="/sandbox" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="tab" value="moves" />
          <select name="state" defaultValue={state} aria-label="State"><option value="">Every move</option><option value="failed">With failures</option><option value="running">Still moving</option><option value="undone">With undos</option></select>
          <select name="mover" defaultValue={sp.mover ?? ''} aria-label="Moved by"><option value="">Anyone</option>{movers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
          <button type="submit" className="btn-secondary btn-sm">Apply</button>
        </form>
        <span className="ml-auto tabular-nums text-[13px] text-ink-500">{list.length}</span>
      </Toolbar>
      {list.length ? <table className="w-full text-[13px]"><thead><tr className="border-b border-line text-left text-ink-500"><th className="px-4 py-2 font-normal">Move</th><th className="px-4 py-2 font-normal">Moved by</th><th className="px-4 py-2 font-normal">When</th><th className="px-4 py-2 font-normal">Result</th></tr></thead>
        <tbody className="divide-y divide-line">{list.map((m) => <tr key={m.id}>
          <td className="px-4 py-2"><Link href={`/sandbox/moves/${m.id}`} className="text-ink-900 hover:text-brand-700">{m.names.join(', ') || 'Contacts'}{m.count > m.names.length ? ` and ${m.count - m.names.length} more` : ''}</Link></td>
          <td className="px-4 py-2 text-ink-700">{m.moverName}</td>
          <td className="px-4 py-2 tabular-nums text-ink-600">{formatInstant(m.createdAt, user.timezone)}</td>
          <td className="px-4 py-2"><span className="flex flex-wrap gap-1.5">{m.done ? <Badge tone="green">{`${m.done} in the CRM`}</Badge> : null}{m.waiting ? <Badge tone="blue">{`${m.waiting} moving`}</Badge> : null}{m.failed ? <Badge tone="red">{`${m.failed} failed`}</Badge> : null}{m.undone ? <Badge tone="gray">{`${m.undone} undone`}</Badge> : null}</span></td>
        </tr>)}</tbody></table> : <EmptyState title={state || sp.mover ? 'No moves match' : 'No moves to the CRM yet'} />}
    </Surface>;
  }

  /** Cold outreach > Campaigns: the Campaigns screen for cold campaigns, with its tabs, filters and New campaign (B134, B200). */
  async function CampaignsTab() {
    return <CampaignsScreen user={user} sp={sp} audience="SANDBOX" title="Cold campaigns" base={COLD_CONTACT_BASE} fixed={{ tab: 'campaigns' }} tabParam="view" newHref="/campaigns/new?audience=cold" />;
  }
}

export const dynamic = 'force-dynamic';
