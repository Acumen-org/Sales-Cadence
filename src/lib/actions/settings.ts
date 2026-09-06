'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../auth/current-user';
import { logAudit, userActor } from '../audit';
import { getSettings, MatchingSettingsSchema, RulesSettingsSchema, saveSettingsSection, SyncSettingsSchema, TwentySettingsSchema } from '../settings';
import type { ActionResult } from './users';

const bool = (v: FormDataEntryValue | null) => v === 'on' || v === 'true';
const list = (v: FormDataEntryValue | null) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function issues(err: { issues: Array<{ path: (string | number)[]; message: string }> }) {
  return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
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
  return { ok: true, message: 'Twenty settings saved.' };
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
    meetingOnStatusOfMeeting: bool(formData.get('meetingOnStatusOfMeeting')),
    meetingStatusValues: list(formData.get('meetingStatusValues')),
    stalledDays: Number(formData.get('stalledDays')),
    reconcileLookbackDays: Number(formData.get('reconcileLookbackDays')),
    defaultDailyRampPerFo: Number(formData.get('defaultDailyRampPerFo')),
  });
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  await saveSettingsSection('rules', parsed.data);
  await logAudit({ entityType: 'settings', entityId: 'rules', action: 'updated', actor: userActor(admin), details: parsed.data });
  revalidatePath('/settings');
  revalidatePath('/tasks');
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
