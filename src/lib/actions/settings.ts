'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../auth/current-user';
import { logAudit, userActor } from '../audit';
import { cleanupSandboxCrmPeople } from '../sandbox/crm-cleanup';
import { crmCheckWords, CRM_CHECK_RUNNING, RUN_NOW_BUDGET_MS, runCrmCheck } from '../sandbox/crm-check';
import { crmValueChoices, crmValueRefusal } from '../sandbox/cold-settings';
import { CallingSettingsSchema, getSettings, LinkedInSettingsSchema, MatchingSettingsSchema, RulesSettingsSchema, SandboxSettingsSchema, saveSettingsSection, SyncSettingsSchema, TwentySettingsSchema } from '../settings';
import { applyNeverProspectRule } from '../non-prospects';
import type { ActionResult } from './users';
import { issueText } from '../form-errors';

const bool = (v: FormDataEntryValue | null) => v === 'on' || v === 'true';
const list = (v: FormDataEntryValue | null) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Parse a JSON array from a hidden field; undefined lets the zod default apply. */
function jsonList(v: FormDataEntryValue | null): unknown {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function issues(err: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return issueText(err.issues);
}

export async function saveTwentySettingsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const current = await getSettings();
  let schema: Record<string, unknown> | null = current.twenty.schema ?? null;
  const schemaText = String(formData.get('schema') ?? '').trim();
  if (schemaText) {
    try {
      const parsed = JSON.parse(schemaText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'Schema overrides must be a JSON object.' };
      schema = parsed;
    } catch {
      return { ok: false, error: 'Schema overrides are not valid JSON.' };
    }
  } else {
    schema = null;
  }
  const apiKeyInput = String(formData.get('apiKey') ?? '');
  const apiKey = formData.get('clearApiKey') === 'on' ? null : apiKeyInput.trim() ? apiKeyInput.trim() : current.twenty.apiKey ?? null;
  const parsed = TwentySettingsSchema.safeParse({ baseUrl: String(formData.get('baseUrl') ?? '').trim() || null, apiKey, schema });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  await saveSettingsSection('twenty', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'twenty', action: 'updated', actor: userActor(admin), details: { baseUrl: parsed.data.baseUrl ?? null, apiKeySet: Boolean(parsed.data.apiKey), schemaOverrides: schema ? Object.keys(schema) : [] } });
  revalidatePath('/settings');
  return { ok: true, message: 'CRM settings saved.' };
}

export async function saveMatchingSettingsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = MatchingSettingsSchema.safeParse({
    outboundEmailTitle: String(formData.get('outboundEmailTitle') ?? ''),
    outboundCallTitle: String(formData.get('outboundCallTitle') ?? ''),
    callNotesTitle: String(formData.get('callNotesTitle') ?? ''),
    cadencePrefix: String(formData.get('cadencePrefix') ?? '[Cadence]'),
    callNotesCompleteCall: bool(formData.get('callNotesCompleteCall')),
    evidenceGraceDays: Number(formData.get('evidenceGraceDays') ?? 1),
  });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  await saveSettingsSection('matching', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'matching', action: 'updated', actor: userActor(admin), details: parsed.data });
  revalidatePath('/settings');
  return { ok: true, message: 'Matching rules saved.' };
}

export async function saveRulesSettingsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = RulesSettingsSchema.safeParse({
    dailyCap: Number(formData.get('dailyCap')),
    workingDays: formData.getAll('workingDays').map((d) => Number(d)),
    clockMode: String(formData.get('clockMode') ?? 'shift'),
    companyReplyPausesColleagues: bool(formData.get('companyReplyPausesColleagues')),
    meetingOnOpportunityCreated: bool(formData.get('meetingOnOpportunityCreated')),
    internalDomains: list(formData.get('internalDomains')).map((d) => d.replace(/^.*@/, '').replace(/^\/+|\/+$/g, '')),
    internalCompanyNames: formData.has('internalCompanyNames') ? list(formData.get('internalCompanyNames')) : undefined,
    clickToCallUrl: String(formData.get('clickToCallUrl') ?? '').trim(),
    reconcileLookbackDays: Number(formData.get('reconcileLookbackDays')),
    workspaceTimezone: String(formData.get('workspaceTimezone') ?? 'America/Chicago'),
    defaultDailyRampPerFo: Number(formData.get('defaultDailyRampPerFo')),
    exitOnBounce: bool(formData.get('exitOnBounce')),
    answeredCallIsReply: bool(formData.get('answeredCallIsReply')),
    callDispositions: jsonList(formData.get('callDispositionsJson')),
    skipReasons: jsonList(formData.get('skipReasonsJson')),
  });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  const dupKeys = (list: Array<{ key: string }>) => list.map((x) => x.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupKeys(parsed.data.callDispositions).length) return { ok: false, error: `Duplicate call outcome keys: ${dupKeys(parsed.data.callDispositions).join(', ')}` };
  if (dupKeys(parsed.data.skipReasons).length) return { ok: false, error: `Duplicate skip reason keys: ${dupKeys(parsed.data.skipReasons).join(', ')}` };
  await saveSettingsSection('rules', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'rules', action: 'updated', actor: userActor(admin), details: parsed.data });
  revalidatePath('/settings');
  revalidatePath('/tasks');
  // Internal domains change what counts as an external meeting, so the weekly boxes must refresh.
  revalidatePath('/home');
  revalidatePath('/meetings');
  return { ok: true, message: 'Rules saved.' };
}

export async function saveSyncSettingsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = SyncSettingsSchema.safeParse({
    writeCompletionNotes: bool(formData.get('writeCompletionNotes')),
    mirrorOpenTasks: bool(formData.get('mirrorOpenTasks')),
    deleteMirroredTaskOnSkip: bool(formData.get('deleteMirroredTaskOnSkip')),
    writeCadenceTaskIdField: bool(formData.get('writeCadenceTaskIdField')),
  });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  await saveSettingsSection('sync', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'sync', action: 'updated', actor: userActor(admin), details: parsed.data });
  revalidatePath('/settings');
  return { ok: true, message: 'Sync settings saved.' };
}

/** The never-prospect and not-account lists. Saved on their own so the Rules tab's form stays whole. */
export async function saveNonProspectRulesAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const current = await getSettings();
  const domains = (v: FormDataEntryValue | null) => list(v).map((d) => d.toLowerCase().replace(/^.*@/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
  const parsed = RulesSettingsSchema.safeParse({
    ...current.rules,
    neverProspectDomains: domains(formData.get('neverProspectDomains')),
    neverProspectNames: list(formData.get('neverProspectNames')),
    notAccountDomains: domains(formData.get('notAccountDomains')),
  });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  await saveSettingsSection('rules', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'rules', action: 'updated', actor: userActor(admin), details: { neverProspectDomains: parsed.data.neverProspectDomains.length, neverProspectNames: parsed.data.neverProspectNames.length, notAccountDomains: parsed.data.notAccountDomains.length } });
  const applied = await applyNeverProspectRule();
  revalidatePath('/settings');
  revalidatePath('/accounts');
  revalidatePath('/people');
  return { ok: true, message: applied.blocked.length ? `Rules saved. ${applied.blocked.length} account${applied.blocked.length === 1 ? '' : 's'} blocked.` : 'Rules saved.' };
}

export async function applyNeverProspectRuleAction(): Promise<ActionResult> {
  await requireAdmin();
  const applied = await applyNeverProspectRule();
  revalidatePath('/settings');
  revalidatePath('/accounts');
  revalidatePath('/people');
  return { ok: true, message: applied.blocked.length ? `${applied.blocked.length} account${applied.blocked.length === 1 ? '' : 's'} blocked.` : 'Nothing new to block.' };
}

/**
 * Settings > Cold outreach: the CRM-ready rules, what Move to CRM writes, the bulk limit (at most 50),
 * undo and retention. The CRM values must be options the CRM has, never a typo (B060).
 */
export async function saveSandboxSettingsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const current = await getSettings();
  const num = (k: string) => (formData.get(k) ? Number(formData.get(k)) : undefined);
  const parsed = SandboxSettingsSchema.safeParse({
    enabled: bool(formData.get('enabled')),
    moveBatchLimit: num('moveBatchLimit'),
    undoDays: num('undoDays'),
    retentionInactiveDays: num('retentionInactiveDays'),
    retentionUnworkedDays: num('retentionUnworkedDays'),
    leadSource: String(formData.get('leadSource') ?? '').trim() || undefined,
    leadSourceFallback: String(formData.get('leadSourceFallback') ?? '').trim() || undefined,
    // One box per option; a comma list still reads, for a caller that posts it that way.
    contactType: formData.getAll('contactType').flatMap((v) => list(v)),
    listCategory: String(formData.get('listCategory') ?? '').trim() || undefined,
    pipelineStage: String(formData.get('pipelineStage') ?? '').trim() || undefined,
    requireFirm: bool(formData.get('requireFirm')),
    requireEmailOrPhone: bool(formData.get('requireEmailOrPhone')),
    requireOwnerLogin: bool(formData.get('requireOwnerLogin')),
    requirePod: bool(formData.get('requirePod')),
    cleanupAutoCreated: bool(formData.get('cleanupAutoCreated')),
  });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  const refusal = crmValueRefusal(parsed.data, await crmValueChoices({ current: current.sandbox }));
  if (refusal) return { ok: false, error: refusal };
  await saveSettingsSection('sandbox', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'sandbox', action: 'updated', actor: userActor(admin), details: parsed.data });
  revalidatePath('/settings');
  return { ok: true, message: 'Cold outreach settings saved.' };
}

/** Settings > Calling: what counts as a connect and a conversation. */
export async function saveCallingSettingsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const num = (k: string) => (formData.get(k) ? Number(formData.get(k)) : undefined);
  const parsed = CallingSettingsSchema.safeParse({ connectSeconds: num('connectSeconds'), conversationSeconds: num('conversationSeconds') });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  await saveSettingsSection('calling', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'calling', action: 'updated', actor: userActor(admin), details: parsed.data });
  revalidatePath('/settings');
  return { ok: true, message: 'Calling settings saved.' };
}

const LINKEDIN_FIELDS: Record<string, string> = {
  withdrawAfterDays: 'Withdraw a request after',
  resendAfterDays: 'Send it again after',
  maxResends: 'Times to send again',
  messageAfterAcceptDays: 'Message after acceptance',
  inviteWeeklyLimit: 'Requests per account per week',
};

/** "Withdraw a request after must be at least 7.", not Zod's "Too small: expected number to be >=7". */
function linkedInIssues(list: ReadonlyArray<{ code: string; path: PropertyKey[]; message: string; minimum?: unknown; maximum?: unknown }>): string {
  return [...new Set(list.map((i) => {
    const label = LINKEDIN_FIELDS[String(i.path[0])];
    if (!label) return issueText([i]);
    if (i.code === 'too_small') return `${label} must be at least ${String(i.minimum)}.`;
    if (i.code === 'too_big') return `${label} must be at most ${String(i.maximum)}.`;
    return `${label} must be a whole number.`;
  }))].join(' ');
}

/** Settings > LinkedIn: when Cadence asks a teammate to withdraw, resend or message. It never acts on LinkedIn itself. */
export async function saveLinkedInSettingsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const num = (k: string) => (formData.get(k) ? Number(formData.get(k)) : undefined);
  const parsed = LinkedInSettingsSchema.safeParse({
    enabled: bool(formData.get('enabled')),
    withdrawAfterDays: num('withdrawAfterDays'),
    resendAfterDays: num('resendAfterDays'),
    maxResends: num('maxResends'),
    messageAfterAcceptDays: num('messageAfterAcceptDays'),
    inviteWeeklyLimit: num('inviteWeeklyLimit'),
  });
  if (!parsed.success) return { ok: false, error: linkedInIssues(parsed.error.issues) };
  await saveSettingsSection('linkedin', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'linkedin', action: 'updated', actor: userActor(admin), details: parsed.data });
  revalidatePath('/settings');
  return { ok: true, message: 'LinkedIn settings saved.' };
}

/** Settings > Cold outreach: run the CRM cleanup now instead of waiting for the worker's next five minutes. */
export async function cleanupSandboxCrmNowAction(): Promise<ActionResult> {
  const admin = await requireAdmin();
  const stats = await cleanupSandboxCrmPeople({ actor: userActor(admin) });
  revalidatePath('/settings');
  if (!stats.ran) return { ok: false, error: stats.reason ?? 'The cleanup did not run.' };
  const parts = [`${stats.removed} removed`, `${stats.kept} kept and flagged`];
  if (stats.dryRun) parts.push(`${stats.dryRun} would be removed (dry run)`);
  if (stats.errors) parts.push(`${stats.errors} failed`);
  return { ok: true, message: `Cleanup: ${parts.join(', ')}.` };
}

/**
 * Settings > Cold outreach: the nightly CRM check, run now (B168). It asks the CRM for a shorter while
 * than the night does, and is recorded like a nightly run, with who started it.
 */
export async function runCrmCheckNowAction(): Promise<ActionResult> {
  const admin = await requireAdmin();
  const result = await runCrmCheck({ by: admin.name, budgetMs: RUN_NOW_BUDGET_MS });
  revalidatePath('/settings');
  if (result.busy) return { ok: false, error: CRM_CHECK_RUNNING };
  if (result.error || !result.stats) return { ok: false, error: `The CRM check failed: ${result.error ?? 'no result'}. It runs again tonight.` };
  return { ok: true, message: crmCheckWords(result.stats) };
}
