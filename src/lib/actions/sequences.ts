'use server';
import { requireUser } from '../auth/current-user';
import type { ActionResult } from './users';
async function retired(): Promise<ActionResult> { await requireUser(); return { ok: false, error: 'Build outreach inside a campaign. The standalone sequence library has been retired.' }; }
export async function createSequenceAction(_data: FormData) { return retired(); }
export async function saveSequenceAction(_data: FormData) { return retired(); }
export async function updateSequenceMetaAction(_data: FormData) { return retired(); }
