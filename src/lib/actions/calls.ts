'use server';

import { prisma } from '../db';
import { requireUser } from '../auth/current-user';
import { canActOnTask, toActor } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { getSettings } from '../settings';

export type CallResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Place a call through whatever the workspace has configured (Settings > Rules > click-to-call).
 *
 * Cadence does not talk to a telephony provider itself. It posts who to ring and which task it
 * is for to one endpoint the team owns, and reports back what that endpoint said. With no
 * endpoint configured the task screen falls back to a tel: link, which is why this refuses
 * rather than pretending: a button that silently does nothing is worse than no button.
 */
export async function startCallAction(payload: { taskId: string }): Promise<CallResult> {
  const user = await requireUser();
  const settings = await getSettings();
  const endpoint = settings.rules.clickToCallUrl?.trim();
  if (!endpoint) return { ok: false, error: 'No click-to-call endpoint is configured. Dial the number instead, then log the call.' };

  const task = await prisma.task.findUnique({
    where: { id: payload.taskId },
    include: { enrollment: { select: { podId: true, person: { select: { id: true, phone: true, firstName: true, lastName: true } } } } },
  });
  if (!task) return { ok: false, error: 'Task not found.' };
  if (!canActOnTask(toActor(user), { foUserId: task.foUserId, podId: task.enrollment.podId })) return { ok: false, error: 'This is not your task.' };
  const to = task.enrollment.person.phone;
  if (!to) return { ok: false, error: 'This person has no phone number in Twenty.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, personId: task.enrollment.person.id, taskId: task.id, userId: user.id, userEmail: user.email }),
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, 300);
    if (!response.ok) return { ok: false, error: `Call service responded ${response.status}. ${body}`.trim() };
    await logAudit({ entityType: 'task', entityId: task.id, action: 'call_placed', actor: userActor(user), details: { to, endpoint } });
    return { ok: true, message: `Calling ${to}. Log the outcome when you are done.` };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not reach the call service (${reason}). Dial the number instead.` };
  } finally {
    clearTimeout(timer);
  }
}
