import { prisma } from '../db';
import { isAdmin, isPodManager, isSalesLeader, needsPod, type Actor } from '../auth/rbac';
import { logAudit, type AuditActor } from '../audit';
import { formHolderOf } from './form-holder';

/**
 * A leader's tools for a call form nobody can fill (N010, PLAN 8.1 "Reassign or close someone's
 * pending form"): hand it to another rep, or close it without a form, with a reason. Sales Leaders
 * and Pod Managers of the call's pod, and admins. Both are logged; the call keeps its rep.
 */

export function mayManageForm(a: Actor, call: { podId: string | null }): boolean {
  if (isAdmin(a)) return true;
  return (isSalesLeader(a) || isPodManager(a)) && Boolean(call.podId && a.podIds.includes(call.podId));
}

const WHO_MAY = 'Only the Sales Leaders and Pod Managers of the call\'s pod, and admins, can hand on or close someone\'s call form.';

async function pendingCall(callId: string) {
  const call = await prisma.callLog.findUnique({ where: { id: callId }, select: { id: true, podId: true, userId: true, formUserId: true, formDueAt: true, formDoneAt: true, discardedAt: true } });
  if (!call) return { error: 'Call not found.' } as const;
  if (!call.formDueAt || call.formDoneAt || call.discardedAt) return { error: 'This call has no form waiting.' } as const;
  return { call } as const;
}

export async function handFormTo(callId: string, toUserId: string, reader: Actor, actor: AuditActor): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const found = await pendingCall(callId);
  if ('error' in found) return { ok: false, error: found.error! };
  const call = found.call;
  if (!mayManageForm(reader, call)) return { ok: false, error: WHO_MAY };
  const to = await prisma.user.findUnique({ where: { id: toUserId }, include: { pods: true } });
  if (!to || !to.active || !needsPod(to.role)) return { ok: false, error: 'Choose an active sales rep.' };
  if (call.podId && !isAdmin(reader) && !to.pods.some((p) => p.podId === call.podId)) return { ok: false, error: `${to.name} is not in the call's pod.` };
  const from = formHolderOf(call);
  // Only if nobody filled it or handed it on meanwhile.
  const moved = await prisma.callLog.updateMany({ where: { id: callId, formDoneAt: null, formUserId: call.formUserId }, data: { formUserId: toUserId } });
  if (!moved.count) return { ok: false, error: 'Someone filled in or handed on this form just now. Reload to see it.' };
  await logAudit({ entityType: 'call', entityId: callId, action: 'form_reassigned', actor, details: { from, to: toUserId } });
  return { ok: true, message: `The form is now ${to.name}'s to fill in.` };
}

export async function closeFormWithoutForm(callId: string, reason: string, reader: Actor, actor: AuditActor, now = new Date()): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const why = reason.trim();
  if (!why) return { ok: false, error: 'Say why this call will have no form.' };
  const found = await pendingCall(callId);
  if ('error' in found) return { ok: false, error: found.error! };
  if (!mayManageForm(reader, found.call)) return { ok: false, error: WHO_MAY };
  const closed = await prisma.callLog.updateMany({ where: { id: callId, formDoneAt: null }, data: { formDoneAt: now } });
  if (!closed.count) return { ok: false, error: 'Someone filled in this form just now. Reload to see it.' };
  await logAudit({ entityType: 'call', entityId: callId, action: 'form_closed', actor, details: { holder: formHolderOf(found.call), reason: why.slice(0, 500) } });
  return { ok: true, message: 'Closed without a form. The reason is in the call\'s history.' };
}
