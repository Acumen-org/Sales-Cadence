import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { SessionUser } from '../auth/current-user';
import { ROLES_NEEDING_POD } from '../auth/rbac';
import { getSettings } from '../settings';
import { formatLocalDate, toLocalDate, todayIn } from '../dates';
import { workspaceTimezone } from '../workspace';
import { outcomeLabel } from '../call-outcomes';
import { likeSafe, searchTerms } from '../search-terms';
import { shortDay } from '../task-cues';
import { canAct, type Act, type ColdSubject, type GuardActor, type Refusal } from '../outreach/guard';
import { assignableOwners } from '../outreach/ownership';
import { coldMoveHref, coldRef, subjectHref } from '../subject';
import { coldCues, type ColdCue } from './cues';
import { latestMoves } from './moves-query';
import { displayName } from './normalize';
import {
  BULK_ACTS, COMPUTED_VIEWS, SOURCE_LABELS, VIEW_LABELS, listHref, listRole, ownerFixed, resolveListParams, scopeFor, viewHref, viewsFor,
  type BulkAct, type ColdTableRow, type ListContext, type ListParams, type ListRole, type ListScope, type ListSearch, type ListView,
} from './list-view';

/*
 * The Cold outreach contacts list (PLAN 4.1). It pages in the database (B209): the views that are a
 * filter (Mine, Unclaimed, All, Already in CRM, Moved, Do not contact and removed) count and page in
 * SQL; the views that are a state worked out from several signals (No next step, Ready to move,
 * Closed) narrow their candidates in SQL, read their badges with `coldCues` (the one definition of a
 * contact's state, which the step strip reads too) and page that list of ids. Only the page's own
 * contacts are loaded with what the table shows.
 */

export const LIST_PAGE = 50;

type Sql = Prisma.Sql;
const { sql, join, raw } = Prisma;

// ---------------------------------------------------------------------------
// Search (B055, B206, N079, N085)
// ---------------------------------------------------------------------------

/** Combining accents, stripped after NFD so "Müller" reads "muller" (B206). */
const MARKS = '[̀-ͯ]';
/** Letters NFD does not split: ø, ł, đ, ı, ħ. */
const PLAIN_FROM = 'øØłŁđĐıħĦ';
const PLAIN_TO = 'oOlLdDihH';

/**
 * A value folded for search in the database: accents off, lower case. `unaccent` is not installed and
 * the list adds no column, so the fold is built from what every Postgres has (normalize, translate),
 * and the typed text goes through the same fold as the stored one.
 */
const fold = (e: Sql): Sql => sql`lower(translate(regexp_replace(normalize(${e}, NFD), ${MARKS}, '', 'g'), ${PLAIN_FROM}, ${PLAIN_TO}))`;

const PHONE_CHARS = /^[\d\s()+.\-/]+$/;
/** The digits of a term that is a phone number: only phone characters and 7 or more digits (B055). */
export function phoneDigits(term: string): string | null {
  if (!PHONE_CHARS.test(term)) return null;
  const digits = term.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

const TEXT_FIELDS: Sql[] = [
  sql`c."firstName"`, sql`c."lastName"`, sql`c.email`, sql`c."companyName"`, sql`c."jobTitle"`, sql`c.city`, sql`array_to_string(c."additionalEmails", ' ')`,
  // N085: a Chinese, Japanese or Korean name typed whole, family name first or last, with no space.
  sql`(c."lastName" || c."firstName")`, sql`(c."firstName" || c."lastName")`,
];

function termSql(term: string): Sql {
  const pattern = fold(sql`${`%${likeSafe(term)}%`}::text`);
  const any: Sql[] = TEXT_FIELDS.map((f) => sql`${fold(f)} LIKE ${pattern}`);
  // A pasted Bellwether id or CRD finds its contact exactly.
  any.push(sql`lower(c."bellwetherContactId") = lower(${term})`, sql`c."individualCrd" = ${term}`, sql`c."companyCrd" = ${term}`);
  const digits = phoneDigits(term);
  if (digits) {
    // Stored numbers are E.164; a national number typed with its trunk 0 matches without it.
    for (const d of new Set([digits, digits.replace(/^0+/, '')])) if (d.length >= 7) any.push(sql`c.phone LIKE ${`%${d}%`}`, sql`c."additionalPhones"::text LIKE ${`%${d}%`}`);
  }
  return sql`(${join(any, ' OR ')})`;
}

/**
 * Every word has to match somewhere, as on People. A number typed with spaces ("312 555 0123") is one
 * phone number, and a run of fewer than 7 digits is never read as one (B055).
 */
export function searchSql(q: string): Sql | null {
  const text = q.trim();
  if (!text) return null;
  const terms = phoneDigits(text) ? [text] : searchTerms(text);
  return terms.length ? sql`(${join(terms.map(termSql), ' AND ')})` : null;
}

// ---------------------------------------------------------------------------
// Views and scope
// ---------------------------------------------------------------------------

const FROM = sql`FROM "SandboxContact" c LEFT JOIN "User" o ON o.id = c."ownerId"`;
const ORDER = sql`ORDER BY c."sortName" ASC NULLS LAST, c.id ASC`;
const DNC = sql`(c.status = 'OPTED_OUT' OR (c.status <> 'MOVED' AND c."optedOutAt" IS NOT NULL))`;
const MOVING = sql`EXISTS (SELECT 1 FROM "SandboxMoveItem" mi WHERE mi."sandboxContactId" = c.id AND mi.state IN ('QUEUED', 'RUNNING'))`;
const IN_CRM = sql`(c."crmMatchPersonId" IS NOT NULL OR c."crmAutoPersonId" IS NOT NULL)`;
const OWNED = sql`(c."ownerId" IS NOT NULL AND o.active IS TRUE)`;
const LIVE = sql`(c.status = 'ACTIVE' AND NOT ${DNC} AND NOT ${MOVING})`;
const RUNNING = sql`EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."sandboxContactId" = c.id AND e."personId" IS NULL AND e.status IN ('ACTIVE', 'PAUSED'))`;
const OPEN_NEXT = sql`EXISTS (SELECT 1 FROM "NextAction" n WHERE n."sandboxContactId" = c.id AND n."personId" IS NULL AND n.state = 'OPEN')`;
/** Anything that could be the positive outcome of "Ready to move" (D3); `moveSignals` decides. */
const MAYBE_POSITIVE = sql`(EXISTS (SELECT 1 FROM "CallForm" f JOIN "CallLog" l ON l.id = f."callId" WHERE l."sandboxContactId" = c.id AND f.outcome IN ('meeting_booked', 'connected'))
  OR EXISTS (SELECT 1 FROM "NextAction" n WHERE n."sandboxContactId" = c.id AND n.kind = 'MEETING' AND n.state IN ('OPEN', 'DONE'))
  OR EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."sandboxContactId" = c.id AND e.status IN ('REPLIED', 'MEETING'))
  OR EXISTS (SELECT 1 FROM "SandboxEmail" se WHERE se."sandboxContactId" = c.id AND se.kind = 'REPLY'))`;

/** The badge state each computed view lists. */
const STATE_OF: Partial<Record<ListView, ColdCue['state']>> = { no_next_step: 'no_next_step', ready: 'ready_to_move', closed: 'closed' };

/**
 * Which contacts a view holds, in SQL, in `contactState`'s order: Do not contact, removed, moved,
 * moving, already in the CRM, unclaimed. For a computed view, its candidates: owned live contacts
 * that might be in that state (no campaign and no next step, or a positive outcome).
 */
function viewSql(view: ListView, me: string): Sql {
  switch (view) {
    case 'mine': case 'all': return sql`c.status = 'ACTIVE'`;
    case 'unclaimed': return sql`(${LIVE} AND NOT ${IN_CRM} AND NOT ${OWNED})`;
    case 'in_crm': return sql`(${LIVE} AND ${IN_CRM})`;
    case 'moved': return sql`c.status = 'MOVED'`;
    case 'dnc_removed': return sql`(c.status IN ('OPTED_OUT', 'REMOVED') OR ${DNC})`;
    // N046: contacts with a call waiting for a form the reader holds.
    case 'form_due': return sql`EXISTS (SELECT 1 FROM "CallLog" l WHERE l."sandboxContactId" = c.id AND l."formDueAt" IS NOT NULL AND l."formDoneAt" IS NULL AND l."discardedAt" IS NULL AND (l."formUserId" = ${me} OR (l."formUserId" IS NULL AND l."userId" = ${me})))`;
    case 'any': return sql`TRUE`;
    case 'no_next_step': case 'ready': case 'closed':
      return sql`(${LIVE} AND NOT ${IN_CRM} AND ${OWNED} AND (${MAYBE_POSITIVE} OR (NOT ${RUNNING} AND NOT ${OPEN_NEXT})))`;
  }
}

function ownerSql(owner: string, me: string): Sql {
  if (!owner) return sql`TRUE`;
  if (owner === 'mine') return sql`c."ownerId" = ${me}`;
  if (owner === 'unclaimed') return sql`(c."ownerId" IS NULL OR o.active IS NOT TRUE)`;
  // N033: the owner's access was removed: for their pod's leaders to give to someone.
  if (owner === 'needs_owner') return sql`(c."ownerId" IS NOT NULL AND o.active IS NOT TRUE)`;
  return sql`c."ownerId" = ${owner}`;
}

function podSql(pod: string, myPodIds: readonly string[]): Sql {
  if (!pod) return sql`TRUE`;
  if (pod === 'mine') return sql`c."podId" = ANY(${[...myPodIds]}::text[])`;
  return sql`c."podId" = ${pod}`;
}

type Filter = { view: ListView; owner: string; pod: string; source: string; q: string };

/** What every count shares: the search and the source. */
function baseSql(f: Pick<Filter, 'q' | 'source'>): Sql {
  const parts: Sql[] = [];
  const search = searchSql(f.q);
  if (search) parts.push(search);
  if (f.source) parts.push(sql`c.source::text = ${f.source}`);
  return parts.length ? join(parts, ' AND ') : sql`TRUE`;
}

const scopedSql = (f: Filter, ctx: ListContext): Sql => join([viewSql(f.view, ctx.userId), ownerSql(f.owner, ctx.userId), podSql(f.pod, ctx.myPodIds)], ' AND ');
const whereSql = (f: Filter, ctx: ListContext): Sql => sql`${baseSql(f)} AND ${scopedSql(f, ctx)}`;

/** A computed view's candidates in list order, with their badges. */
async function candidates(f: Filter, ctx: ListContext, today: string): Promise<{ ids: string[]; cues: Map<string, ColdCue> }> {
  const ids = (await prisma.$queryRaw<{ id: string }[]>`SELECT c.id ${FROM} WHERE ${whereSql(f, ctx)} ${ORDER}`).map((r) => r.id);
  return { ids, cues: await coldCues(ids, { today }) };
}

const inState = (list: { ids: string[]; cues: Map<string, ColdCue> }, view: ListView) => list.ids.filter((id) => list.cues.get(id)?.state === STATE_OF[view]);

/** How many contacts a view holds under these filters. */
async function countOf(f: Filter, ctx: ListContext, today: string): Promise<number> {
  if (COMPUTED_VIEWS.has(f.view)) return inState(await candidates(f, ctx, today), f.view).length;
  const [row] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n ${FROM} WHERE ${whereSql(f, ctx)}`;
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type ListTab = { view: ListView; label: string; count: number; href: string };
export type ListChip = { key: 'owner' | 'pod' | 'source'; label: string; isDefault: boolean; href: string };
export type EmptyHint = { words: string; label: string; href: string };
export type ContactList = {
  params: ListParams;
  role: ListRole;
  scope: ListScope;
  rows: ColdTableRow[];
  total: number;
  page: number;
  pages: number;
  /** The quick views with their counts, each counted as it opens (its own owner and pod defaults). */
  tabs: ListTab[];
  /** The filters in force, defaults included, each removable (N081). */
  chips: ListChip[];
  /** Why the list is empty, and which filter hides matches (N079); null when there are rows. */
  empty: { title: string; hint: string; hints: EmptyHint[] } | null;
  /** The Owner filter's choices: active sales reps only (B208). */
  owners: { id: string; name: string }[];
  pods: { id: string; name: string }[];
  myPodIds: string[];
};

/** The reader's list for this query string. A value the list does not know is ignored (B207). */
export async function listContacts(user: SessionUser, sp: ListSearch): Promise<ContactList> {
  const role = listRole(user.role);
  const [owners, pods] = await Promise.all([
    prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.pod.findMany({ where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const myPodIds = user.podIds.filter((id) => pods.some((p) => p.id === id));
  const ctx: ListContext = { role, userId: user.id, ownerIds: new Set(owners.map((o) => o.id)), podIds: new Set(pods.map((p) => p.id)), myPodIds };
  const params = resolveListParams(sp, ctx);
  const today = todayIn(user.timezone);
  const filterOf = (view: ListView): Filter => { const s = scopeFor(view, params, ctx); return { view, owner: s.owner, pod: s.pod, source: params.source, q: params.q }; };
  const views = viewsFor(role, params.view);

  // One query counts every filter view; one candidate list serves the computed views, which share a scope.
  const counts = new Map<ListView, number>();
  const plain = views.filter((v) => !COMPUTED_VIEWS.has(v));
  const columns = plain.map((v) => sql`count(*) FILTER (WHERE ${scopedSql(filterOf(v), ctx)})::int AS ${raw(`"${v}"`)}`);
  const [counted] = await prisma.$queryRaw<Record<string, number>[]>`SELECT ${join(columns, ', ')} ${FROM} WHERE ${baseSql(params)}`;
  for (const v of plain) counts.set(v, Number(counted?.[v] ?? 0));
  const computed = views.some((v) => COMPUTED_VIEWS.has(v)) ? await candidates(filterOf('no_next_step'), ctx, today) : null;
  for (const v of views) if (computed && COMPUTED_VIEWS.has(v)) counts.set(v, inState(computed, v).length);

  const total = counts.get(params.view) ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE));
  const page = Math.min(params.page, pages);
  const pageIds = COMPUTED_VIEWS.has(params.view)
    ? inState(computed!, params.view).slice((page - 1) * LIST_PAGE, page * LIST_PAGE)
    : (await prisma.$queryRaw<{ id: string }[]>`SELECT c.id ${FROM} WHERE ${whereSql(filterOf(params.view), ctx)} ${ORDER} LIMIT ${LIST_PAGE} OFFSET ${(page - 1) * LIST_PAGE}`).map((r) => r.id);

  const scope = scopeFor(params.view, params, ctx);
  const rows = await tableRows(pageIds, user, today, computed?.cues);
  return {
    params, role, scope, rows, total, page, pages,
    tabs: views.map((v) => ({ view: v, label: VIEW_LABELS[v], count: counts.get(v) ?? 0, href: viewHref(params, v) })),
    chips: chipsFor(params, scope, { owners, pods, myPodIds }),
    empty: rows.length ? null : await emptyFor(params, scope, ctx, today, owners),
    owners, pods, myPodIds,
  };
}

function chipsFor(p: ListParams, scope: ListScope, names: { owners: { id: string; name: string }[]; pods: { id: string; name: string }[]; myPodIds: string[] }): ListChip[] {
  const chips: ListChip[] = [];
  if (!ownerFixed(p.view) && scope.owner) {
    const label = scope.owner === 'mine' ? 'Owner: you' : scope.owner === 'unclaimed' ? 'Unclaimed' : scope.owner === 'needs_owner' ? 'Needs a new owner' : `Owner: ${names.owners.find((o) => o.id === scope.owner)?.name ?? 'a rep'}`;
    chips.push({ key: 'owner', label, isDefault: scope.ownerDefault, href: listHref(p, { owner: '' }) });
  }
  if (scope.pod) {
    const mine = names.myPodIds.length === 1 ? names.pods.find((x) => x.id === names.myPodIds[0])?.name ?? 'your pod' : 'your pods';
    const label = scope.pod === 'mine' ? `Pod: ${mine}` : `Pod: ${names.pods.find((x) => x.id === scope.pod)?.name ?? 'a pod'}`;
    chips.push({ key: 'pod', label, isDefault: scope.podDefault, href: listHref(p, { pod: '' }) });
  }
  if (p.source) chips.push({ key: 'source', label: `Source: ${SOURCE_LABELS[p.source]}`, isDefault: false, href: listHref(p, { source: null }) });
  return chips;
}

const EMPTY_WORDS: Record<ListView, { title: string; hint: string }> = {
  mine: { title: 'No contacts of yours yet', hint: 'Claim one from Unclaimed, or add one. Your contacts show here until they move to the CRM.' },
  no_next_step: { title: 'Every contact has a next step', hint: 'A contact with no campaign and no next step shows here, so none is forgotten.' },
  unclaimed: { title: 'Nothing to claim', hint: 'New contacts arrive from Bellwether. Unclaimed ones wait here for a rep.' },
  ready: { title: 'Nobody is ready to move yet', hint: 'A contact is ready with complete CRM details and a positive outcome: connected with warm or hot interest, a meeting booked, or a reply.' },
  in_crm: { title: 'No contacts already in the CRM', hint: 'When the CRM gains someone who is also here, outreach stops and the contact shows here, ready to be moved.' },
  closed: { title: 'No closed contacts', hint: 'After Not interested, or Wrong number with no other way to reach them, a contact is closed until someone sets a new next step.' },
  all: { title: 'No contacts in Cold outreach yet', hint: 'Contacts arrive from Bellwether, or add one by hand.' },
  moved: { title: 'Nobody moved to the CRM yet', hint: 'When a contact is ready, select it and choose Move to CRM.' },
  dnc_removed: { title: 'Nobody marked Do not contact or removed', hint: 'Contacts who ask not to be contacted, and contacts removed from the list, show here.' },
  form_due: { title: 'No forms waiting', hint: 'After each call its form waits here until you fill it in.' },
  any: { title: 'No contacts match', hint: 'Search looks at names, firms, titles, emails, Bellwether ids, CRDs, and phone numbers of 7 digits or more.' },
};

/** Why nothing shows: the view's own words, or which filter hides the matches, each with a link that lifts it (N079). */
async function emptyFor(p: ListParams, scope: ListScope, ctx: ListContext, today: string, owners: { id: string; name: string }[]): Promise<ContactList['empty']> {
  const base = EMPTY_WORDS[p.view];
  const ownerShown = Boolean(scope.owner) && !ownerFixed(p.view);
  if (!p.q && !p.source && !ownerShown && !scope.pod) return { ...base, hints: [] };
  const here: Filter = { view: p.view, owner: scope.owner, pod: scope.pod, source: p.source, q: p.q };
  const many = (n: number) => `${n} ${n === 1 ? 'match' : 'matches'}`;
  const hints: EmptyHint[] = [];
  if (p.q && p.view !== 'any') {
    const n = await countOf({ ...here, view: 'any', owner: ownerFixed(p.view) ? '' : scope.owner }, ctx, today);
    if (n) hints.push({ words: `${many(n)} with another status.`, label: 'Search every status', href: listHref(p, { view: null }) });
  }
  if (ownerShown) {
    const n = await countOf({ ...here, owner: '' }, ctx, today);
    const whose = scope.owner === 'mine' ? 'of yours' : scope.owner === 'unclaimed' ? 'unclaimed' : scope.owner === 'needs_owner' ? 'waiting for a new owner' : `of ${owners.find((o) => o.id === scope.owner)?.name ?? 'that rep'}'s`;
    if (n) hints.push({ words: `None ${whose}; ${many(n)} with any owner.`, label: 'Show every owner', href: listHref(p, { owner: '' }) });
  }
  if (scope.pod) {
    const n = await countOf({ ...here, pod: '' }, ctx, today);
    if (n) hints.push({ words: `${many(n)} in other pods.`, label: 'Show every pod', href: listHref(p, { pod: '' }) });
  }
  if (p.source) {
    const n = await countOf({ ...here, source: '' }, ctx, today);
    if (n) hints.push({ words: `${many(n)} from another source.`, label: 'Any source', href: listHref(p, { source: null }) });
  }
  if (hints.length) return { title: p.q ? `No match for “${p.q}” in ${VIEW_LABELS[p.view]}` : base.title, hint: 'A filter hides what you are looking for.', hints };
  // No one filter hides anything: the view is empty, or the search finds nobody, or only all the filters together hide it.
  if (!p.q) return { ...base, hints: [] };
  const anywhere = await countOf({ view: 'any', owner: '', pod: '', source: '', q: p.q }, ctx, today);
  if (!anywhere) return { title: `Nothing matches “${p.q}”`, hint: EMPTY_WORDS.any.hint, hints: [] };
  return { title: `No match for “${p.q}” in ${VIEW_LABELS[p.view]}`, hint: 'The filters together hide what you are looking for.', hints: [{ words: `${many(anywhere)} without them.`, label: 'Clear the filters', href: listHref(p, { view: null, owner: '', pod: '', source: null }) }] };
}

// ---------------------------------------------------------------------------
// The page's rows
// ---------------------------------------------------------------------------

const tz = () => workspaceTimezone();

/** A refusal in a few words, for the bulk bar's "leaves out" line (B151). */
function why(r: Refusal): string {
  switch (r.code) {
    case 'opted_out': return 'Do not contact';
    case 'removed': return 'Removed';
    case 'moved': return 'In the CRM already';
    case 'moving': return 'Being moved to the CRM';
    case 'already_yours': return 'Yours already';
    default: return r.reason;
  }
}

/**
 * The table's rows for these ids, in their order: the badge, chips and next from `coldCues`, the last
 * call, and what the reader may do to each, from the guard (B118, B151).
 */
export async function tableRows(ids: string[], user: SessionUser, today: string, known?: Map<string, ColdCue>): Promise<ColdTableRow[]> {
  if (!ids.length) return [];
  const actor: GuardActor = { id: user.id, role: user.role, podIds: user.podIds };
  const [contacts, fresh, moves, settings, assignable] = await Promise.all([
    prisma.sandboxContact.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, status: true, firstName: true, lastName: true, jobTitle: true, companyName: true, ownerId: true, podId: true, source: true, createdAt: true, pushedByName: true,
        twentyPersonId: true, movedById: true, optedOutAt: true, optOutSource: true, crmMatchPersonId: true, crmAutoPersonId: true,
        owner: { select: { name: true, active: true } }, pod: { select: { name: true } },
        calls: { where: { discardedAt: null }, orderBy: [{ startedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], take: 1, select: { startedAt: true, createdAt: true, formDueAt: true, formDoneAt: true, form: { select: { outcome: true } } } },
        enrollments: { where: { personId: null, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true }, take: 1 },
        nextActions: { where: { personId: null, state: 'OPEN' }, select: { id: true }, take: 1 },
      },
    }),
    coldCues(ids.filter((id) => !known?.has(id)), { today }),
    latestMoves(ids, actor),
    getSettings(),
    // Assign shows only to a reader who has someone to give contacts to (B119).
    assignableOwners(actor),
  ]);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const rows: ColdTableRow[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    const cue = known?.get(id) ?? fresh.get(id);
    if (!c || !cue) continue;
    const name = displayName(c.firstName, c.lastName) || 'Removed contact';
    const ownerActive = Boolean(c.owner?.active);
    const subject: ColdSubject = {
      kind: 'cold', id: c.id, status: c.status, name, ownerId: c.ownerId, ownerName: c.owner?.name ?? null, ownerActive, podId: c.podId, podName: c.pod?.name ?? null,
      twentyPersonId: c.twentyPersonId, movedById: c.movedById, optedOutAt: c.optedOutAt, optOutSource: c.optOutSource, crmMatchPersonId: c.crmMatchPersonId, crmAutoPersonId: c.crmAutoPersonId,
      moving: cue.state === 'moving',
    };
    const check = (act: Act): true | string => { const v = canAct(actor, subject, act); return v.ok ? true : why(v); };
    const inCampaign = c.enrollments.length > 0 || cue.state === 'in_campaign';
    const allows = Object.fromEntries(BULK_ACTS.map((a) => [a, true])) as Record<BulkAct, true | string>;
    allows.claim = check('claim');
    allows.assign = assignable.length ? check('assign') : 'You cannot give contacts to someone else.';
    allows.enroll = cue.state === 'already_in_crm' ? 'Already in the CRM: outreach stopped' : inCampaign && c.status === 'ACTIVE' ? 'Already in a campaign' : check('enroll');
    // PLAN 4.0: an unclaimed contact is claimed first; one already in the CRM is moved, not worked.
    allows.next_step = cue.state === 'unclaimed' && c.status === 'ACTIVE' ? 'Claim first' : cue.state === 'already_in_crm' ? 'Already in the CRM: outreach stopped' : check('next_action');
    // B151: what a rep may do once the contact is theirs reads "Claim first", as on the contact page.
    const claimFirst = (act: Act): true | string => { const v = check(act); return v !== true && cue.state === 'unclaimed' && c.status === 'ACTIVE' && allows.claim === true ? 'Claim first' : v; };
    allows.move = claimFirst('move');
    allows.remove = claimFirst('remove');
    const call = c.calls[0];
    const m = moves.get(id);
    const created = formatLocalDate(toLocalDate(c.createdAt, tz()), 'year');
    const sourceLabel = SOURCE_LABELS[c.source];
    rows.push({
      id, name, sub: [c.jobTitle, c.companyName].filter(Boolean).join(' · ') || null, href: subjectHref(coldRef(id)),
      ownerId: c.ownerId, owner: c.owner?.name ?? null, ownerLeft: Boolean(c.ownerId && !ownerActive), unclaimed: c.status === 'ACTIVE' && !(c.ownerId && ownerActive),
      badge: cue.badge, chips: cue.chips,
      next: cue.next ? { label: cue.next.label, day: shortDay(cue.next.due), overdue: cue.next.overdue } : null,
      lastCall: call ? { outcome: call.form ? outcomeLabel(settings.rules, call.form.outcome) : call.formDueAt && !call.formDoneAt ? 'Form due' : 'No outcome yet', day: formatLocalDate(toLocalDate(call.startedAt ?? call.createdAt, tz())) } : null,
      source: { label: sourceLabel, title: c.source === 'BELLWETHER' ? `Sent from Bellwether${c.pushedByName ? ` by ${c.pushedByName}` : ''} on ${created}` : `${sourceLabel} on ${created}` },
      move: m ? {
        undo: c.status === 'MOVED' && m.canUndo ? { itemId: m.itemId, confirm: m.undoConfirm, campaigns: m.campaigns } : null,
        failed: c.status === 'ACTIVE' && m.state === 'FAILED' ? { error: (m.error ?? 'see the move').replace(/\.+$/, ''), href: coldMoveHref(m.moveId), label: 'See the move', retrying: m.retrying } : null,
      } : null,
      allows, hasWork: inCampaign || c.nextActions.length > 0,
    });
  }
  return rows;
}
