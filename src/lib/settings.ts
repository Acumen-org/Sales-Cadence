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
  meetingOnStatusOfMeeting: z.boolean().default(true),
  /** Values of person.statusOfMeeting that mean a meeting is booked (case-insensitive). */
  meetingStatusValues: z.array(z.string()).default(['BOOKED', 'MEETING_BOOKED', 'Meeting booked', 'Booked']),
  /** Enrollments with no touch in this many days are reported as stalled. */
  stalledDays: z.number().int().min(1).default(7),
  reconcileLookbackDays: z.number().int().min(1).max(90).default(3),
  /** Default daily ramp (new enrollments per FO per day) for new campaigns. */
  defaultDailyRampPerFo: z.number().int().min(1).default(20),
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
let cache: { at: number; value: Settings } | undefined;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await prisma.setting.findMany();
  const raw: Record<string, unknown> = {};
  for (const row of rows) raw[row.key] = row.value;
  const parsed = SettingsSchema.safeParse(raw);
  const value = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  if (!parsed.success) {
    console.warn('[settings] stored settings invalid, using defaults:', parsed.error.message);
  }
  cache = { at: Date.now(), value };
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
  cache = undefined;
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
