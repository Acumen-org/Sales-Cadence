'use server';

import { revalidatePath } from 'next/cache';
import { requireUser, toActor } from '../auth/current-user';
import { userActor } from '../audit';
import { addMeetingBack, approveMeeting, declineMeeting, type ApprovalResult } from '../meetings/approval';
import type { ActionResult } from './users';

/** Meetings with no recording link: approve, decline with a reason, or add a declined one back (owner, 20 Nov 2026). */
async function run(formData: FormData, act: (id: string, user: Awaited<ReturnType<typeof requireUser>>) => Promise<ApprovalResult>): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(formData.get('meetingId') ?? '');
  if (!id) return { ok: false, error: 'Meeting not found.' };
  const r = await act(id, user);
  if (!r.ok) return r;
  revalidatePath('/meetings', 'layout');
  revalidatePath('/accounts', 'layout');
  revalidatePath('/reports');
  revalidatePath('/home');
  return { ok: true, message: r.message };
}

const decider = (user: Awaited<ReturnType<typeof requireUser>>) => ({ ...toActor(user), name: user.name });

export async function approveMeetingAction(formData: FormData): Promise<ActionResult> {
  return run(formData, (id, user) => approveMeeting(id, decider(user), userActor(user)));
}

export async function declineMeetingAction(formData: FormData): Promise<ActionResult> {
  return run(formData, (id, user) => declineMeeting(id, String(formData.get('reason') ?? ''), decider(user), userActor(user)));
}

export async function addMeetingBackAction(formData: FormData): Promise<ActionResult> {
  return run(formData, (id, user) => addMeetingBack(id, decider(user), userActor(user)));
}
