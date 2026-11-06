import { prisma } from '../db';
import { env } from '../env';
import { addDays, todayIn } from '../dates';
import { getSettings, getTwentySchema, type SandboxSettings } from '../settings';
import { workspaceTimezone } from '../workspace';
import { getTwentyClient, type TwentyClient } from '../twenty';
import type { TwentyIntrospection } from '../twenty/types';
import { optionLabel } from '../twenty/labels';
import { STUCK_MS } from './bellwether-api';
import { lastCrmCheck, type CrmCheckRun } from './crm-check';
import { cleanupCounts } from './crm-cleanup';
import { retentionForecast, WARN_DAYS } from './retention';
import { releaseReport, type ReleaseReport } from '../outreach/release';
import { NIGHTLY_MARKER, type NightlyMarker } from '../nightly';
import { outreachHealth, type HealthLine } from '../outreach/health';

/*
 * Settings > Cold outreach (PLAN 4.7): what the page reads, in words. The CRM values Move to CRM
 * writes come from the CRM's own options (B060, B213); the nightly CRM check and retention say when
 * they last ran and what they found (B168; retention is read only, owner 5 Nov); Bellwether's
 * connection says whether pushes arrive and whether any were cut off (S9). Admins change the rules;
 * everyone else reads them, with the names of who can change them (B215).
 */

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// The CRM values Move to CRM writes (B060)
// ---------------------------------------------------------------------------

export type CrmValueKey = 'leadSource' | 'contactType' | 'listCategory' | 'pipelineStage';
export const CRM_VALUE_KEYS: CrmValueKey[] = ['leadSource', 'contactType', 'listCategory', 'pipelineStage'];
export type CrmChoice = { value: string; label: string };
/** Each field's options: the CRM's own when it lists them (`fromCrm`), else the values Cadence knows. */
export type CrmValueChoices = { fields: Record<CrmValueKey, { options: CrmChoice[]; fromCrm: boolean }>; why: string | null };
type CrmValues = Pick<SandboxSettings, 'leadSource' | 'leadSourceFallback' | 'contactType' | 'listCategory' | 'pipelineStage'>;

export const CRM_VALUE_LABELS = { leadSource: 'Lead source', leadSourceFallback: 'Lead source if that option is missing', contactType: 'Contact type', listCategory: 'List category', pipelineStage: 'Pipeline stage' } as const;

/** Lead sources the CRM's people already carry, for when the CRM does not list its options. */
async function leadSourcesSeen(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ v: string }[]>`SELECT DISTINCT unnest("leadSource") AS v FROM "PersonCache" WHERE "deletedAt" IS NULL ORDER BY v LIMIT 200`;
  return rows.map((r) => r.v).filter(Boolean);
}

/**
 * The options for lead source, contact type, list category and pipeline stage, read from the CRM's
 * person fields. When the CRM cannot say (not reachable, the demo workspace, an introspection without
 * options), the lists hold what Cadence knows instead, and `why` says so.
 */
export async function crmValueChoices(opts: { client?: TwentyClient | null; current?: SandboxSettings } = {}): Promise<CrmValueChoices> {
  const [schema, current] = await Promise.all([getTwentySchema(), opts.current ? Promise.resolve(opts.current) : getSettings().then((s) => s.sandbox)]);
  let intro: TwentyIntrospection | null = null;
  let why: string | null = null;
  try {
    const client = opts.client === undefined ? await getTwentyClient() : opts.client;
    if (client) intro = await client.introspect();
    else why = 'The CRM is not connected';
  } catch (err) {
    why = /not configured/i.test(err instanceof Error ? err.message : String(err)) ? 'The CRM is not connected' : 'The CRM could not be reached';
  }
  const person = intro?.objects.find((o) => o.nameSingular === schema.objects.person.singular);
  const fieldOf: Record<CrmValueKey, string> = { leadSource: schema.person.leadSource, contactType: schema.person.contactType, listCategory: schema.person.listCategory, pipelineStage: schema.person.pipelineStageField };
  const known: Record<CrmValueKey, string[]> = { leadSource: await leadSourcesSeen(), contactType: schema.personValues.contactType, listCategory: schema.personValues.listCategory, pipelineStage: schema.personValues.pipelineStage };
  const saved: Record<CrmValueKey, string[]> = { leadSource: [current.leadSource, current.leadSourceFallback], contactType: current.contactType, listCategory: [current.listCategory], pipelineStage: [current.pipelineStage] };
  const fields = {} as CrmValueChoices['fields'];
  for (const key of CRM_VALUE_KEYS) {
    const info = person?.fields.find((f) => f.name === fieldOf[key]);
    fields[key] = info?.options?.length
      ? { fromCrm: true, options: info.options.map((value) => ({ value, label: info.optionLabels?.[value] || optionLabel(value) })) }
      : { fromCrm: false, options: [...new Set([...known[key], ...saved[key]].filter(Boolean))].map((value) => ({ value, label: optionLabel(value) })) };
  }
  if (!why && CRM_VALUE_KEYS.some((k) => !fields[k].fromCrm)) why = intro?.source === 'mock' ? 'The demo workspace lists no options' : 'The CRM did not list the options of every field';
  return { fields, why };
}

const has = (choices: CrmValueChoices, key: CrmValueKey, value: string) => choices.fields[key].options.some((o) => o.value === value);

/** Saved values the CRM no longer offers, and what Move to CRM does with them meanwhile (B060). */
export function crmValueIssues(s: CrmValues, choices: CrmValueChoices): string[] {
  const out: string[] = [];
  const gone = (key: CrmValueKey, value: string) => choices.fields[key].fromCrm && value && !has(choices, key, value);
  const name = (v: string) => `"${optionLabel(v)}"`;
  if (gone('leadSource', s.leadSource)) out.push(`Lead source ${name(s.leadSource)} is not an option in the CRM any more: moves write ${gone('leadSource', s.leadSourceFallback) ? 'no lead source' : `the other one, ${name(s.leadSourceFallback)}`} until you pick one.`);
  if (gone('leadSource', s.leadSourceFallback) && !gone('leadSource', s.leadSource)) out.push(`The other lead source, ${name(s.leadSourceFallback)}, is not an option in the CRM any more.`);
  for (const v of s.contactType) if (gone('contactType', v)) out.push(`Contact type ${name(v)} is not an option in the CRM any more: moves leave it out until you pick again.`);
  if (gone('listCategory', s.listCategory)) out.push(`List category ${name(s.listCategory)} is not an option in the CRM any more: moves write no list category until you pick one.`);
  if (gone('pipelineStage', s.pipelineStage)) out.push(`Pipeline stage ${name(s.pipelineStage)} is not an option in the CRM any more: moves write no pipeline stage until you pick one.`);
  return out;
}

/** On save: every value must be one of the field's options, never a typo (B060). Null when all are. */
export function crmValueRefusal(s: CrmValues, choices: CrmValueChoices): string | null {
  const checks: [keyof typeof CRM_VALUE_LABELS, CrmValueKey, string][] = [
    ['leadSource', 'leadSource', s.leadSource], ['leadSourceFallback', 'leadSource', s.leadSourceFallback],
    ...s.contactType.map((v): [keyof typeof CRM_VALUE_LABELS, CrmValueKey, string] => ['contactType', 'contactType', v]),
    ['listCategory', 'listCategory', s.listCategory], ['pipelineStage', 'pipelineStage', s.pipelineStage],
  ];
  const bad = checks.find(([, key, value]) => !has(choices, key, value));
  if (!bad) return null;
  const where = choices.fields[bad[1]].fromCrm ? 'one of the CRM\'s options' : 'one Cadence knows';
  return `${CRM_VALUE_LABELS[bad[0]]} "${bad[2]}" is not ${where}. Pick one from the list.`;
}

// ---------------------------------------------------------------------------
// The suppression list, in words (B213)
// ---------------------------------------------------------------------------

/** Any code in words: every underscore, not only the first (B213), in sentence case. */
export const codeWords = (code: string) => {
  const t = code.replace(/_/g, ' ').trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const KIND_WORDS: Record<string, string> = {
  email: 'Email', phone: 'Direct or mobile phone', linkedin: 'LinkedIn', bellwether_id: 'Bellwether id', individual_crd: 'Individual CRD', phone_subject: 'Shared line, for one person only',
};
const REASON_WORDS: Record<string, string> = { opted_out: 'Opted out', erased: 'Erased at their request', do_not_contact: 'Do not contact' };
const SOURCE_WORDS: Record<string, string> = {
  call_form: 'Post-call form', contact_page: 'Contact page', person_page: 'Person page', suppression_list: 'Added to this list', skip_reason: 'Step skipped: asked not to be contacted', erase: 'Erase', bellwether: 'Bellwether',
};

export function suppressionWords(s: { kind: string; reason: string; source: string | null }): { kind: string; reason: string; source: string | null } {
  return { kind: KIND_WORDS[s.kind] ?? codeWords(s.kind), reason: REASON_WORDS[s.reason] ?? codeWords(s.reason), source: s.source ? SOURCE_WORDS[s.source] ?? codeWords(s.source) : null };
}

export const SUPPRESSIONS_SHOWN = 50;
export type SuppressionRow = { id: string; label: string; kind: string; reason: string; source: string | null; at: Date };

// ---------------------------------------------------------------------------
// Bellwether, the CRM check and retention
// ---------------------------------------------------------------------------

export type BellwetherHealth = {
  keySet: boolean; previousKey: boolean; enabled: boolean;
  lastPush: { at: Date; by: string } | null;
  /** The last 7 days: pushes, contacts added, pushes cut off and marked failed (S9's sweep), contacts Cadence failed on. */
  week: { pushes: number; contacts: number; cutOff: number; internalErrors: number };
  /** Pushes still being processed after 10 minutes: the sweep marks them failed within 5 more. */
  stuck: number;
  /** Pushes cut off in the last 7 days that Bellwether has not sent again. */
  failed: number;
};

export async function bellwetherHealth(enabled: boolean, now = new Date()): Promise<BellwetherHealth> {
  const e = env();
  const week = new Date(now.getTime() - 7 * DAY);
  const [lastPush, pushes, contacts, cutOff, internalErrors, stuck, failed] = await Promise.all([
    prisma.bellwetherPush.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, pushedByEmail: true } }),
    prisma.bellwetherPush.count({ where: { createdAt: { gte: week } } }),
    prisma.sandboxContact.count({ where: { createdAt: { gte: week }, source: 'BELLWETHER' } }),
    prisma.auditLog.count({ where: { entityType: 'bellwether', action: 'push_swept', createdAt: { gte: week } } }),
    prisma.bellwetherPushItem.count({ where: { reason: 'internal_error', createdAt: { gte: week } } }),
    prisma.bellwetherPush.count({ where: { state: 'PROCESSING', createdAt: { lt: new Date(now.getTime() - STUCK_MS) } } }),
    prisma.bellwetherPush.count({ where: { state: 'FAILED', createdAt: { gte: week } } }),
  ]);
  const pusher = lastPush ? await prisma.user.findFirst({ where: { email: { equals: lastPush.pushedByEmail, mode: 'insensitive' } }, select: { name: true } }) : null;
  return {
    keySet: Boolean(e.BELLWETHER_API_KEY), previousKey: Boolean(e.BELLWETHER_API_KEY_PREVIOUS), enabled,
    lastPush: lastPush ? { at: lastPush.createdAt, by: pusher?.name ?? lastPush.pushedByEmail } : null,
    week: { pushes, contacts, cutOff, internalErrors }, stuck, failed,
  };
}

export type RetentionView = {
  /** When the nightly run last worked out the forecast; null before the first. */
  at: Date | null;
  horizonDays: number;
  /** Contacts that would be removed in the next `horizonDays`. */
  total: number;
  /** The first day with removals, and how many fall on it. */
  next: { on: string; count: number } | null;
  /** Due by the next nightly run after the forecast: "N will be removed tonight". */
  atNextRun: number;
  /** Due within the warning period: their owners have been told. */
  warned: number;
  warnDays: number;
  /** Kept because they are also in the CRM: Move to CRM needed (N075). */
  moveToCrmNeeded: number;
  removedLastRun: number;
  inactiveDays: number;
  unworkedDays: number;
};

export async function retentionView(s: SandboxSettings): Promise<RetentionView> {
  const f = await retentionForecast();
  const at = f ? new Date(f.at) : null;
  const first = f?.items[0]?.dueOn ?? null;
  const warnBy = at ? new Date(at.getTime() + WARN_DAYS * DAY).toISOString().slice(0, 10) : null;
  return {
    at, horizonDays: f?.horizonDays ?? 30, total: f?.total ?? 0,
    next: first ? { on: first, count: f!.items.filter((i) => i.dueOn === first).length } : null,
    atNextRun: at ? f!.items.filter((i) => i.dueOn <= new Date(at.getTime() + DAY).toISOString().slice(0, 10)).length : 0,
    warned: warnBy ? f!.items.filter((i) => i.dueOn <= warnBy).length : 0, warnDays: WARN_DAYS,
    moveToCrmNeeded: f?.moveToCrmNeeded.count ?? 0, removedLastRun: f?.removedTonight ?? 0,
    inactiveDays: s.retentionInactiveDays, unworkedDays: s.retentionUnworkedDays,
  };
}

export type ColdOutreachSettingsData = {
  sandbox: SandboxSettings;
  /** Admins only: the CRM's options for the values Move to CRM writes. */
  choices: CrmValueChoices | null;
  valueIssues: string[];
  bellwether: BellwetherHealth;
  /** `late`: the nightly jobs have not run since the day before yesterday; `durationMs` how long the last run took, `runningSince` a run in progress (N087). */
  crmCheck: { last: CrmCheckRun | null; nightly: NightlyView | null; inCrmNow: number };
  retention: RetentionView;
  cleanup: { total: number; week: number; kept: number };
  /** The list itself for admins; everyone else sees how long it is. */
  suppressions: { total: number; rows: SuppressionRow[] };
  /** Who can change these settings (B215). */
  admins: string[];
  /** Admins only: what the release put right and listed in the data since 3 Nov (PLAN 9.7); null until the worker has run it. */
  release: ReleaseReport | null;
  /** Admins only: the health card, one line per thing that can quietly stop cold outreach (PLAN 4.7). */
  health: HealthLine[] | null;
};

export type NightlyView = { day: string; at: string; late: boolean; durationMs: number | null; runningSince: string | null };

/** The nightly jobs' own marker (B214, N087): when they last finished, how long they took, whether they are late (not run yesterday or today) or running now. */
function nightlyRun(value: unknown, now: Date): NightlyView | null {
  const v = value as NightlyMarker | null | undefined;
  if (!v?.day || !v.at) return null;
  return { day: v.day, at: v.at, late: v.day < addDays(todayIn(workspaceTimezone(), now), -1), durationMs: v.durationMs ?? null, runningSince: v.running?.startedAt ?? null };
}

/** Everything Settings > Cold outreach shows. `full` is for admins: the CRM's options and the suppression list. */
export async function loadColdOutreachSettings(opts: { full: boolean }, now = new Date()): Promise<ColdOutreachSettingsData> {
  const { sandbox } = await getSettings();
  const [choices, bellwether, last, nightly, inCrmNow, retention, cleanup, total, rows, admins, release, health] = await Promise.all([
    opts.full ? crmValueChoices({ current: sandbox }) : Promise.resolve(null),
    bellwetherHealth(sandbox.enabled, now),
    lastCrmCheck(),
    prisma.setting.findUnique({ where: { key: NIGHTLY_MARKER } }),
    prisma.sandboxContact.count({ where: { status: 'ACTIVE', OR: [{ crmMatchPersonId: { not: null } }, { crmAutoPersonId: { not: null } }] } }),
    retentionView(sandbox),
    cleanupCounts(now),
    prisma.suppression.count(),
    opts.full ? prisma.suppression.findMany({ orderBy: { createdAt: 'desc' }, take: SUPPRESSIONS_SHOWN }) : Promise.resolve([]),
    prisma.user.findMany({ where: { role: 'ADMIN', active: true }, orderBy: { name: 'asc' }, select: { name: true } }),
    opts.full ? releaseReport() : Promise.resolve(null),
    opts.full ? outreachHealth(now) : Promise.resolve(null),
  ]);
  return {
    sandbox, choices, valueIssues: choices ? crmValueIssues(sandbox, choices) : [],
    bellwether,
    crmCheck: { last, nightly: nightlyRun(nightly?.value, now), inCrmNow },
    retention, cleanup,
    suppressions: { total, rows: rows.map((s) => ({ id: s.id, ...suppressionWords(s), label: s.label ?? KIND_WORDS[s.kind] ?? codeWords(s.kind), at: s.createdAt })) },
    admins: admins.map((a) => a.name),
    release, health,
  };
}
