import type { Role } from '@prisma/client';
import { COLD_OUTREACH_BASE } from '../cold-outreach-paths';
import type { Cue } from './cues';

/*
 * The contacts list's quick views and filters (PLAN 4.1). Which view is open, whose contacts and which
 * pod it shows, and what each role opens on (N081). No database here: the page, the toolbar and the
 * tests all read the same rules.
 *
 * A view says which contacts by their state (the badge `contactState` gives them); the Owner, Pod and
 * Source filters say whose. Mine and Unclaimed are both: they fix the owner, so "Unclaimed" is one
 * choice that can never contradict another filter (N082).
 */

export const LIST_VIEWS = ['mine', 'no_next_step', 'unclaimed', 'ready', 'in_crm', 'closed', 'all', 'moved', 'dnc_removed', 'form_due', 'any'] as const;
export type ListView = (typeof LIST_VIEWS)[number];

export const VIEW_LABELS: Record<ListView, string> = {
  mine: 'My contacts', no_next_step: 'Needs a next step', unclaimed: 'To claim', ready: 'Ready to move', in_crm: 'Already in CRM', closed: 'Closed',
  all: 'All', moved: 'Moved', dnc_removed: 'Do not contact and removed', form_due: 'Forms due', any: 'Every status',
};

/** Views whose state needs an owner: no_next_step, ready and closed are states of owned contacts only. */
export const OWNED_VIEWS: ReadonlySet<ListView> = new Set(['mine', 'no_next_step', 'ready', 'closed']);
/** Views whose state needs the contacts' badges worked out (`coldCues`), not only a database filter. */
export const COMPUTED_VIEWS: ReadonlySet<ListView> = new Set(['no_next_step', 'ready', 'closed']);
/** Views that say whose contacts they hold, so the Owner filter does not apply to them. */
const FIXED_OWNER: Partial<Record<ListView, string>> = { mine: 'mine', unclaimed: 'unclaimed', form_due: '' };
export const ownerFixed = (view: ListView) => FIXED_OWNER[view] !== undefined;

/** How the list opens for a role (N081): reps on their own contacts, pod leaders on their pods, admins on everyone. */
export type ListRole = 'rep' | 'leader' | 'admin' | 'reader';
export function listRole(role: Role): ListRole {
  if (role === 'JUNIOR_FO' || role === 'SENIOR_FO') return 'rep';
  if (role === 'SALES_LEADER' || role === 'POD_MANAGER') return 'leader';
  return role === 'ADMIN' ? 'admin' : 'reader';
}

export const CONTACT_SOURCES = ['BELLWETHER', 'MANUAL', 'CSV', 'CALL', 'LINKEDIN'] as const;
export type ContactSourceValue = (typeof CONTACT_SOURCES)[number];
export const SOURCE_LABELS: Record<ContactSourceValue, string> = { BELLWETHER: 'Bellwether', MANUAL: 'Added here', CSV: 'From a file', CALL: 'From a call', LINKEDIN: 'From LinkedIn' };

/** The page's query string, as Next hands it over. */
export type ListSearch = Partial<Record<'view' | 'q' | 'owner' | 'pod' | 'source' | 'page' | 'status' | 'ready' | 'flash' | 'flashTone', string | string[]>>;

/** What the URL asks for, checked. `owner` and `pod` are null when the URL does not say (the default applies) and '' for "everyone". */
export type ListParams = { view: ListView; viewExplicit: boolean; q: string; owner: string | null; pod: string | null; source: ContactSourceValue | ''; page: number };

/** What the URL is checked against: the reader, the owners the Owner filter offers and the pods there are. */
export type ListContext = { role: ListRole; userId: string; ownerIds: ReadonlySet<string>; podIds: ReadonlySet<string>; myPodIds: readonly string[] };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The URL read into a view and filters. A value the list does not know is ignored, never an error
 * (B207); the old /sandbox values (owner=all|mine|unclaimed|needs_owner, status=…, ready=ready) keep
 * working.
 */
export function resolveListParams(sp: ListSearch, ctx: ListContext): ListParams {
  const q = (first(sp.q) ?? '').trim().slice(0, 200);
  const rawSource = (first(sp.source) ?? '').trim().toUpperCase();
  const source = (CONTACT_SOURCES as readonly string[]).includes(rawSource) ? (rawSource as ContactSourceValue) : '';
  let owner: string | null = null;
  const rawOwner = first(sp.owner);
  if (rawOwner !== undefined) {
    const o = rawOwner.trim();
    if (o === '' || o === 'all') owner = '';
    else if (o === 'mine' || o === 'unclaimed' || o === 'needs_owner' || ctx.ownerIds.has(o)) owner = o;
  }
  let pod: string | null = null;
  const rawPod = first(sp.pod);
  if (rawPod !== undefined) {
    const p = rawPod.trim();
    if (p === '' || p === 'all') pod = '';
    else if (p === 'mine') pod = ctx.myPodIds.length ? 'mine' : '';
    else if (ctx.podIds.has(p)) pod = p;
  }
  const rawView = first(sp.view);
  let view: ListView | null = rawView && (LIST_VIEWS as readonly string[]).includes(rawView) ? (rawView as ListView) : null;
  if (!view) {
    // The old /sandbox filters, as the views they meant.
    const status = first(sp.status);
    if (owner === 'unclaimed' || status === 'unclaimed') view = 'unclaimed';
    else if (status === 'moved') view = 'moved';
    else if (status === 'opted_out' || status === 'removed') view = 'dnc_removed';
    else if (first(sp.ready) === 'ready') view = 'ready';
  }
  const viewExplicit = Boolean(view);
  if (!view) {
    // A search looks everywhere: every status, every owner (N079). Otherwise the role's own view.
    if (q) view = 'any';
    else if (owner === 'mine' || (owner === null && ctx.role === 'rep')) view = 'mine';
    else view = 'all';
  }
  // A view that fixes the owner has no other owner; "Unclaimed" never sits beside a view that needs an owner (N082).
  if (ownerFixed(view) || (owner === 'unclaimed' && OWNED_VIEWS.has(view))) owner = null;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(first(sp.page) ?? '1', 10) || 1));
  return { view, viewExplicit, q, owner, pod, source, page };
}

/** Whose contacts and which pod a view shows, after the role's defaults, and which of the two are defaults. */
export type ListScope = { owner: string; pod: string; ownerDefault: boolean; podDefault: boolean };

export function scopeFor(view: ListView, p: Pick<ListParams, 'owner' | 'pod'>, ctx: Pick<ListContext, 'role' | 'myPodIds'>): ListScope {
  let owner: string;
  let ownerDefault = false;
  const fixed = FIXED_OWNER[view];
  if (fixed !== undefined) owner = fixed;
  else if (p.owner !== null && !(p.owner === 'unclaimed' && OWNED_VIEWS.has(view))) owner = p.owner;
  else if (view === 'all' || view === 'any') owner = '';
  else { owner = ctx.role === 'rep' ? 'mine' : ''; ownerDefault = owner !== ''; }
  let pod: string;
  let podDefault = false;
  if (p.pod !== null) pod = p.pod;
  else if (view === 'any' || owner === 'mine' || !ctx.myPodIds.length) pod = '';
  // Leaders open on their pods; anyone claims from their own pods' unclaimed contacts (the step strip's count).
  else if (ctx.role === 'leader' || (view === 'unclaimed' && ctx.role === 'rep')) { pod = 'mine'; podDefault = true; }
  else pod = '';
  return { owner, pod, ownerDefault, podDefault };
}

/** The quick views a role is offered, in the order of PLAN 4.1. Admins and Biz Ops own nothing, so they get no Mine. */
export function viewsFor(role: ListRole, current: ListView): ListView[] {
  const views: ListView[] = ['mine', 'unclaimed', 'no_next_step', 'ready', 'all', 'in_crm', 'closed', 'moved', 'dnc_removed'];
  const shown = role === 'rep' || role === 'leader' ? views : views.filter((v) => v !== 'mine');
  if (current === 'form_due') shown.splice(1, 0, 'form_due');
  if (current === 'any') shown.unshift('any');
  return shown;
}

/** Query keys that belong to one moment, never carried into the next address. */
const TRANSIENT = ['page', 'flash', 'flashTone'];

/**
 * The list's address with `patch` applied: the view and every filter the reader chose survive (B192),
 * the page, a flash message and old /sandbox keys do not. null deletes a key; '' keeps an explicit "All".
 */
export function listHref(p: ListParams, patch: Record<string, string | null> = {}, base = COLD_OUTREACH_BASE): string {
  const next = new URLSearchParams();
  if (p.viewExplicit) next.set('view', p.view);
  if (p.q) next.set('q', p.q);
  if (p.owner !== null) next.set('owner', p.owner);
  if (p.pod !== null) next.set('pod', p.pod);
  if (p.source) next.set('source', p.source);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) next.delete(k);
    else next.set(k, v);
  }
  if (!('page' in patch)) for (const k of TRANSIENT) next.delete(k);
  const query = next.toString();
  return query ? `${base}?${query}` : base;
}

/** A quick view's address: Mine and Unclaimed fix the owner, and a view that needs an owner drops "Unclaimed" (N082). */
export function viewHref(p: ListParams, view: ListView): string {
  const patch: Record<string, string | null> = { view };
  if (ownerFixed(view) || (OWNED_VIEWS.has(view) && p.owner === 'unclaimed')) patch.owner = null;
  return listHref(p, patch);
}

/**
 * What choosing an owner in the toolbar does to the view (N082). "Unclaimed" and "Mine" are views of
 * their own; any other owner on one of those views opens All for that owner.
 */
export function ownerPatch(value: string, view: ListView): Record<string, string | null> {
  if (value === 'unclaimed') return OWNED_VIEWS.has(view) || view === 'all' || view === 'form_due' ? { view: 'unclaimed', owner: null } : { owner: value };
  if (value === 'mine' && (view === 'all' || ownerFixed(view))) return { view: 'mine', owner: null };
  if (ownerFixed(view)) return { view: 'all', owner: value };
  if (value === 'needs_owner' && OWNED_VIEWS.has(view)) return { view: 'all', owner: value };
  return { owner: value };
}

/**
 * Where the list goes after a bulk action: the same view and filters (B192), with the result as a
 * `?flash=` message that survives the refresh (B148). A refusal reads as an error, and a result that
 * left some contacts out as a warning; a page that runs out of rows is brought back by the page.
 */
export function flashHref(pathname: string, current: string, r: { ok: true; message?: string; data?: unknown } | { ok: false; error: string }): string {
  const next = new URLSearchParams(current);
  next.delete('flash');
  next.delete('flashTone');
  next.set('flash', (r.ok ? r.message ?? 'Done.' : r.error).slice(0, 300));
  const refused = r.ok && r.data && typeof r.data === 'object' && 'refused' in r.data ? Number((r.data as { refused: unknown }).refused) || 0 : 0;
  if (!r.ok) next.set('flashTone', 'error');
  else if (refused) next.set('flashTone', 'warn');
  return `${pathname}?${next.toString()}`;
}

/** The owner the toolbar shows for a view: the view's own when it fixes one. */
export function shownOwner(view: ListView, scope: ListScope): string {
  return FIXED_OWNER[view] ?? scope.owner;
}

// ---------------------------------------------------------------------------
// A row as the table draws it
// ---------------------------------------------------------------------------

/** The bulk actions (PLAN 4.1). Release is not one: letting go is done on the contact. */
export const BULK_ACTS = ['claim', 'assign', 'enroll', 'next_step', 'move', 'remove'] as const;
export type BulkAct = (typeof BULK_ACTS)[number];

export type ColdTableRow = {
  id: string;
  name: string;
  /** "title · firm" under the name. */
  sub: string | null;
  href: string;
  ownerId: string | null;
  /** The owner's name; "(left)" when their access was removed. */
  owner: string | null;
  ownerLeft: boolean;
  /** A live contact nobody owns: amber "Unclaimed" in the Owner column. */
  unclaimed: boolean;
  badge: Cue;
  chips: Cue[];
  /** The earlier of the contact's next step and its campaign's next step (N083). */
  next: { label: string; day: string; overdue: boolean } | null;
  lastCall: { outcome: string; day: string } | null;
  source: { label: string; title: string };
  /** A moved contact's Undo, while the reader may; a failed move with its fix (B036, B106). */
  move: { undo: { itemId: string; confirm: string; campaigns: { enrollmentId: string; name: string }[] } | null; failed: { error: string; href: string; label: string; retrying?: boolean } | null } | null;
  /** What the reader may do to this contact from the list: true, or why not, in words (B118, B151). */
  allows: Record<BulkAct, true | string>;
  /** Has an open next step or a running campaign: Assign hands it over too. */
  hasWork: boolean;
};
