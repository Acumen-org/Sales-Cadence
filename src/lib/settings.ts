import { z } from 'zod';
import { prisma } from './db';
import { env } from './env';
import { defaultNoteTitlePatterns, mergeTwentySchema, type TwentySchema, type TwentySchemaOverride } from './twenty/twenty-schema';

// ---------------------------------------------------------------------------
// Schema (each top-level key is one row in the `Setting` table)
// ---------------------------------------------------------------------------

const regexString = z.string().refine(
  (s) => {
    try {
      new RegExp(s, 'i');
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Invalid regular expression' },
);

export const TwentySettingsSchema = z.object({
  /** Overrides env TWENTY_API_URL when set. */
  baseUrl: z.string().trim().optional().nullable(),
  /** Overrides env TWENTY_API_KEY when set. Stored in the database in plain text. */
  apiKey: z.string().trim().optional().nullable(),
  /** Field mapping overrides, merged over twenty-schema.ts defaults. */
  schema: z.record(z.any()).optional().nullable(),
});

export const MatchingSettingsSchema = z.object({
  outboundEmailTitle: regexString.default(defaultNoteTitlePatterns.outboundEmail),
  outboundCallTitle: regexString.default(defaultNoteTitlePatterns.outboundCall),
  callNotesTitle: regexString.default(defaultNoteTitlePatterns.callNotes),
  cadencePrefix: z.string().default(defaultNoteTitlePatterns.cadencePrefix),
  /** Treat "Call Notes [date]" notes as a completed outbound call. */
  callNotesCompleteCall: z.boolean().default(true),
  /** Evidence older than this many days before the task existed is ignored. */
  evidenceGraceDays: z.number().int().min(0).max(30).default(1),
});

export const RulesSettingsSchema = z.object({
  dailyCap: z.number().int().min(1).max(500).default(40),
  /** 0 = Sunday ... 6 = Saturday. */
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).default([1, 2, 3, 4, 5]),
  /** shift: late steps push later steps by the same delay. hold: keep the planned dates. */
  clockMode: z.enum(['shift', 'hold']).default('shift'),
  companyReplyPausesColleagues: z.boolean().default(false),
  meetingOnOpportunityCreated: z.boolean().default(true),
  reconcileLookbackDays: z.number().int().min(1).max(90).default(3),
  /** Default daily ramp (new enrollments per FO per day) for new campaigns. */
  defaultDailyRampPerFo: z.number().int().min(1).default(20),
  /**
   * Our own email domains. An attendee or participant outside these is "external", which is how
   * Cadence tells a real prospect meeting from an internal one.
   */
  internalDomains: z
    .array(z.string().trim().toLowerCase())
    .default(['acumen-strategy.com', 'prairie-hill.com', 'glynac.ai', 'acubooth.com']),
  /**
   * Endpoint that places a call, owned by us (a Twilio-backed service, for instance). Cadence
   * posts { to, personId, taskId, userId, userEmail } and reports what comes back. Blank means
   * the task screen offers a tel: link instead of a Call button.
   */
  clickToCallUrl: z
    .string()
    .trim()
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'Enter an http(s) URL, or leave it blank.')
    .default(''),
  /** A skip reason flagged as bounce ends the sequence (Outreach: Bounced state). */
  exitOnBounce: z.boolean().default(true),
  /** A call logged with an "answered" disposition counts as a reply and finishes the sequence. */
  answeredCallIsReply: z.boolean().default(true),
  /** Call outcomes an FO must pick when completing a call (Outreach: dispositions). */
  callDispositions: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        answered: z.boolean().default(false),
        /** Mark the person's phone as bad data. */
        badPhone: z.boolean().default(false),
      }),
    )
    .default([
      { key: 'connected', label: 'Connected', answered: true, badPhone: false },
      { key: 'gatekeeper', label: 'Spoke to gatekeeper', answered: false, badPhone: false },
      { key: 'voicemail', label: 'Left voicemail', answered: false, badPhone: false },
      { key: 'no_answer', label: 'No answer', answered: false, badPhone: false },
      { key: 'busy', label: 'Busy / call back', answered: false, badPhone: false },
      { key: 'wrong_number', label: 'Wrong number', answered: false, badPhone: true },
    ]),
  /** Skip reasons offered to FOs; `exit` ends the enrollment with that reason. */
  skipReasons: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        exit: z.enum(['none', 'bounced', 'not_interested', 'opted_out', 'bad_data']).default('none'),
        badEmail: z.boolean().default(false),
        badPhone: z.boolean().default(false),
      }),
    )
    .default([
      { key: 'bounced', label: 'Email bounced', exit: 'bounced', badEmail: true, badPhone: false },
      { key: 'wrong_details', label: 'Wrong or missing contact details', exit: 'bad_data', badEmail: false, badPhone: false },
      { key: 'not_interested', label: 'Not interested', exit: 'not_interested', badEmail: false, badPhone: false },
      { key: 'opted_out', label: 'Asked not to be contacted', exit: 'opted_out', badEmail: false, badPhone: false },
      { key: 'already_talking', label: 'Already in conversation elsewhere', exit: 'none', badEmail: false, badPhone: false },
      { key: 'no_linkedin', label: 'No LinkedIn profile', exit: 'none', badEmail: false, badPhone: false },
      { key: 'other', label: 'Other', exit: 'none', badEmail: false, badPhone: false },
    ]),
});

export const SyncSettingsSchema = z.object({
  /** Write `[Cadence] Email 2 sent by Alisa` notes to Twenty on completion. */
  writeCompletionNotes: z.boolean().default(true),
  /** Mirror open Cadence tasks as Twenty Tasks. */
  mirrorOpenTasks: z.boolean().default(true),
  /** When a Cadence task is skipped or cancelled, delete its mirrored Twenty task (else mark done). */
  deleteMirroredTaskOnSkip: z.boolean().default(true),
  /** Write the Cadence task id into the optional Task.cadenceTaskId field. */
  writeCadenceTaskIdField: z.boolean().default(false),
});

export const SettingsSchema = z.object({
  twenty: TwentySettingsSchema.default({}),
  matching: MatchingSettingsSchema.default({}),
  rules: RulesSettingsSchema.default({}),
  sync: SyncSettingsSchema.default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsSection = keyof Settings;
export type MatchingSettings = Settings['matching'];
export type RulesSettings = Settings['rules'];
export type SyncSettings = Settings['sync'];

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

// ---------------------------------------------------------------------------
// Load / save with a short in-process cache
// ---------------------------------------------------------------------------

const CACHE_MS = 5_000;
// On globalThis, not module scope: Next.js bundles pages and server actions as separate module
// instances in the same process, so a module-level cache would not see invalidations.
const g = globalThis as unknown as { __cadenceSettingsCache?: { at: number; value: Settings } };

export async function getSettings(): Promise<Settings> {
  const cached = g.__cadenceSettingsCache;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const rows = await prisma.setting.findMany();
  const raw: Record<string, unknown> = {};
  for (const row of rows) raw[row.key] = row.value;
  const parsed = SettingsSchema.safeParse(raw);
  const value = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  if (!parsed.success) {
    console.warn('[settings] stored settings invalid, using defaults:', parsed.error.message);
  }
  g.__cadenceSettingsCache = { at: Date.now(), value };
  return value;
}

export async function saveSettingsSection<K extends SettingsSection>(key: K, value: Settings[K]): Promise<Settings[K]> {
  const parsed = SettingsSchema.shape[key].parse(value) as Settings[K];
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: parsed as object },
    update: { value: parsed as object },
  });
  invalidateSettingsCache();
  return parsed;
}

export function invalidateSettingsCache() {
  g.__cadenceSettingsCache = undefined;
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export async function getTwentySchema(): Promise<TwentySchema> {
  const s = await getSettings();
  return mergeTwentySchema((s.twenty.schema ?? undefined) as TwentySchemaOverride | undefined);
}

export type TwentyConnection = { mode: 'mock' | 'graphql'; baseUrl: string | null; apiKey: string | null; dryRun: boolean };

export async function getTwentyConnection(): Promise<TwentyConnection> {
  const s = await getSettings();
  const e = env();
  return {
    mode: e.TWENTY_MODE,
    baseUrl: (s.twenty.baseUrl || e.TWENTY_API_URL || null)?.replace(/\/+$/, '') ?? null,
    apiKey: s.twenty.apiKey || e.TWENTY_API_KEY || null,
    dryRun: e.CADENCE_DRY_RUN,
  };
}

/** Effective daily cap for a user: personal override, else global. */
export function effectiveDailyCap(user: { dailyCap: number | null }, rules: RulesSettings): number {
  return user.dailyCap ?? rules.dailyCap;
}

/** Domain part of an email address, lower-cased. */
export function domainOf(email: string | null | undefined): string | null {
  const at = (email ?? '').lastIndexOf('@');
  return at > 0 ? email!.slice(at + 1).trim().toLowerCase() : null;
}

/** True when the address is outside our own domains (i.e. a prospect, not a colleague). */
export function isExternalEmail(email: string | null | undefined, internalDomains: string[]): boolean {
  const d = domainOf(email);
  if (!d) return false;
  return !internalDomains.some((i) => d === i || d.endsWith(`.${i}`));
}
