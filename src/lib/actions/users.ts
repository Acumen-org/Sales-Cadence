'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAdmin } from '../auth/current-user';
import { hashPassword, validatePasswordStrength } from '../auth/password';
import { logAudit, userActor } from '../audit';
import { getTwentyClient } from '../twenty';
import { WORKSPACE_TIMEZONE } from '../workspace';
import { localDateToInstant } from '../dates';
import { loadSyncTasks, syncTaskInclude, syncTaskResolved, syncTasksCreated, type SyncTask } from '../engine/sync-out';

export type ActionResult = { ok: true; message?: string; redirectTo?: string; data?: unknown } | { ok: false; error: string };

const RoleSchema = z.enum(['ADMIN', 'SALES_LEADER', 'SENIOR_FO', 'JUNIOR_FO']);
const UserFields = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(200),
  role: RoleSchema,
  password: z.string().max(500).optional(),
  podIds: z.array(z.string().min(1).max(200)).max(100).default([]).transform((ids) => [...new Set(ids)]),
});

function formValues(formData: FormData, fallbackEmail = '') {
  return {
    email: formData.get('email') ?? fallbackEmail,
    name: formData.get('name'), role: formData.get('role'),
    password: formData.get('password') ?? undefined,
    podIds: formData.getAll('podIds').map(String),
  };
}

async function validPods(ids: string[], db: Prisma.TransactionClient | typeof prisma = prisma) {
  return await db.pod.count({ where: { id: { in: ids }, archived: false } }) === ids.length;
}

/** Login email is the directory key; mapping never depends on a hand-entered CRM id. */
async function resolveMember(email: string, existing?: { email: string; twentyMemberId: string | null }) {
  try {
    const members = await (await getTwentyClient()).listWorkspaceMembers();
    return members.find((member) => member.email?.trim().toLowerCase() === email)?.id ?? (existing?.email.toLowerCase() === email ? existing.twentyMemberId : null);
  } catch {
    return existing?.email.toLowerCase() === email ? existing.twentyMemberId : null;
  }
}

function refresh() { revalidatePath('/settings'); revalidatePath('/tasks'); revalidatePath('/campaigns'); revalidatePath('/reports'); revalidatePath('/home'); }

export async function createUserAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = UserFields.safeParse(formValues(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  const d = parsed.data;
  const weak = validatePasswordStrength(d.password ?? '');
  if (weak) return { ok: false, error: weak };
  const existing = await prisma.user.findUnique({ where: { email: d.email } });
  if (existing?.active) return { ok: false, error: 'That email already belongs to a team member.' };
  if (!(await validPods(d.podIds))) return { ok: false, error: 'Choose existing, active pods.' };
  if (existing) {
    // Found in Twenty by the worker, or removed earlier: this form is how they get access, so it
    // sets everything an enabled account needs rather than sending the admin to Restore and Edit.
    await prisma.user.update({
      where: { id: existing.id },
      data: { name: d.name, role: d.role, passwordHash: await hashPassword(d.password!), active: true, timezone: WORKSPACE_TIMEZONE, dailyCap: null, twentyMemberId: existing.twentyMemberId ?? await resolveMember(d.email), pods: { deleteMany: {}, create: d.podIds.map((podId) => ({ podId })) } },
    });
    await logAudit({ entityType: 'user', entityId: existing.id, action: 'enabled', actor: userActor(admin), details: { role: d.role, pods: d.podIds } });
    refresh();
    return { ok: true, message: 'Team member added.' };
  }
  const twentyMemberId = await resolveMember(d.email);
  if (twentyMemberId && await prisma.user.findUnique({ where: { twentyMemberId } })) return { ok: false, error: 'That CRM email is already linked to another team member.' };
  const user = await prisma.user.create({ data: { email: d.email, name: d.name, role: d.role, passwordHash: await hashPassword(d.password!), timezone: WORKSPACE_TIMEZONE, twentyMemberId, pods: { create: d.podIds.map((podId) => ({ podId })) } } });
  await logAudit({ entityType: 'user', entityId: user.id, action: 'created', actor: userActor(admin), details: { role: d.role, pods: d.podIds } });
  refresh();
  return { ok: true, message: 'Team member added.' };
}

export async function updateUserAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return { ok: false, error: 'Team member not found.' };
  const parsed = UserFields.safeParse(formValues(formData, existing.email));
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  const d = parsed.data;
  if (existing.id === admin.id && d.role !== 'ADMIN') return { ok: false, error: 'You cannot remove your own administrator access.' };
  if (!(await validPods(d.podIds))) return { ok: false, error: 'Choose existing, active pods.' };
  const duplicate = await prisma.user.findUnique({ where: { email: d.email } });
  if (duplicate && duplicate.id !== userId) return { ok: false, error: 'That email already belongs to another team member.' };
  const twentyMemberId = await resolveMember(d.email, existing);
  const linked = twentyMemberId ? await prisma.user.findUnique({ where: { twentyMemberId } }) : null;
  if (linked && linked.id !== userId) return { ok: false, error: 'That CRM email is already linked to another team member.' };
  let passwordHash: string | undefined;
  if (d.password) {
    const weak = validatePasswordStrength(d.password); if (weak) return { ok: false, error: weak };
    passwordHash = await hashPassword(d.password);
  }
  const result = await prisma.$transaction(async (tx): Promise<ActionResult> => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const current = await tx.user.findUnique({ where: { id: userId } });
    if (!current) return { ok: false, error: 'Team member not found.' };
    if (!(await validPods(d.podIds, tx))) return { ok: false, error: 'Choose existing, active pods.' };
    const stranded = await tx.enrollment.count({ where: { foUserId: userId, status: { in: ['ACTIVE', 'PAUSED'] }, podId: { not: null, notIn: d.podIds } } });
    if (stranded) return { ok: false, error: 'Transfer live enrollments before removing this team member from their pod.' };
    await tx.user.update({ where: { id: userId }, data: { email: d.email, name: d.name, role: d.role, timezone: WORKSPACE_TIMEZONE, twentyMemberId, dailyCap: null, ...(passwordHash ? { passwordHash } : {}) } });
    await tx.userPod.deleteMany({ where: { userId } });
    if (d.podIds.length) await tx.userPod.createMany({ data: d.podIds.map((podId) => ({ userId, podId })) });
    if (passwordHash || current.role !== d.role || current.email !== d.email) await tx.session.deleteMany({ where: { userId } });
    await logAudit({ entityType: 'user', entityId: userId, action: 'updated', actor: userActor(admin), details: { role: d.role, pods: d.podIds, passwordReset: Boolean(passwordHash) } }, tx);
    return { ok: true, message: 'Team member updated.' };
  });
  if (!result.ok) return result;
  refresh();
  return result;
}

/** Soft removal retains authored history; live work must move to an eligible colleague. */
export async function setUserAccessAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');
  const restore = formData.get('active') === 'true';
  const replacementId = String(formData.get('replacementId') ?? '');
  if (!restore && userId === admin.id) return { ok: false, error: 'You cannot remove your own access.' };
  const result = await prisma.$transaction(async (tx): Promise<{ error: string | null; tasks: SyncTask[] }> => {
    const lockIds = [...new Set([userId, ...(!restore && replacementId ? [replacementId] : [])])].sort();
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" IN (${Prisma.join(lockIds)}) ORDER BY "id" FOR UPDATE`);
    const existing = await tx.user.findUnique({ where: { id: userId } });
    if (!existing) return { error: 'Team member not found.', tasks: [] };
    const open = !restore ? await tx.enrollment.findMany({ where: { foUserId: userId, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true, podId: true } }) : [];
    const pending: SyncTask[] = [];
    if (open.length) {
      const replacement = replacementId && replacementId !== userId ? await tx.user.findUnique({ where: { id: replacementId }, include: { pods: { where: { pod: { archived: false } } } } }) : null;
      if (!replacement?.active || open.some((enrollment) => enrollment.podId && !replacement.pods.some((pod) => pod.podId === enrollment.podId))) return { error: 'Transfer open work to an active team member assigned to every affected pod.', tasks: [] };
      const enrollmentIds = open.map((enrollment) => enrollment.id);
      pending.push(...await tx.task.findMany({ where: { enrollmentId: { in: enrollmentIds }, state: 'PENDING' }, include: syncTaskInclude }));
      await tx.enrollment.updateMany({ where: { id: { in: enrollmentIds }, foUserId: userId, status: { in: ['ACTIVE', 'PAUSED'] } }, data: { foUserId: replacementId } });
      for (const task of pending) await tx.task.updateMany({ where: { id: task.id, state: 'PENDING' }, data: { foUserId: replacementId, dueAt: localDateToInstant(task.snoozedTo ?? task.dueDate, WORKSPACE_TIMEZONE, 9), twentyTaskId: null } });
      for (const enrollment of open) await logAudit({ entityType: 'enrollment', entityId: enrollment.id, action: 'reassigned', actor: userActor(admin), details: { from: userId, to: replacementId, reason: 'team_access_removed' } }, tx);
    }
    await tx.user.update({ where: { id: userId }, data: { active: restore, timezone: WORKSPACE_TIMEZONE } });
    if (!restore) await tx.session.deleteMany({ where: { userId } });
    await logAudit({ entityType: 'user', entityId: userId, action: restore ? 'restored' : 'removed', actor: userActor(admin), details: { replacementId: replacementId || null, transferredEnrollments: restore ? 0 : open.length } }, tx);
    return { error: null, tasks: pending };
  });
  if (result.error) return { ok: false, error: result.error };
  for (const task of result.tasks) if (task.twentyTaskId) await syncTaskResolved(task);
  await syncTasksCreated(await loadSyncTasks(result.tasks.map((task) => task.id)));
  refresh();
  return { ok: true, message: restore ? 'Access restored.' : 'Access removed. History retained.' };
}

const PodSchema = z.object({ name: z.string().trim().min(1).max(120), podOwnerValue: z.string().trim().max(120).optional() });

export async function createPodAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = PodSchema.safeParse({ name: formData.get('name'), podOwnerValue: formData.get('podOwnerValue') ?? undefined });
  if (!parsed.success) return { ok: false, error: 'Enter a pod name.' };
  const data = { name: parsed.data.name, podOwnerValue: parsed.data.podOwnerValue || parsed.data.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') };
  if (!data.podOwnerValue) return { ok: false, error: 'Enter a name containing letters or numbers.' };
  const exists = await prisma.pod.findFirst({ where: { OR: [{ name: data.name }, { podOwnerValue: data.podOwnerValue }] } });
  if (exists) return { ok: false, error: 'That pod already exists. Restore it if it was removed.' };
  const pod = await prisma.pod.create({ data });
  await logAudit({ entityType: 'pod', entityId: pod.id, action: 'created', actor: userActor(admin), details: data });
  refresh();
  return { ok: true, message: 'Pod added.' };
}

export async function deletePodAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const podId = String(formData.get('podId') ?? '');
  const result = await prisma.$transaction(async (tx): Promise<ActionResult> => {
    await tx.$queryRaw`SELECT "id" FROM "Pod" WHERE "id" = ${podId} FOR UPDATE`;
    const pod = await tx.pod.findUnique({ where: { id: podId } });
    if (!pod) return { ok: false, error: 'Pod not found.' };
    const inUse = await tx.enrollment.count({ where: { podId, status: { in: ['ACTIVE', 'PAUSED'] } } });
    if (inUse) return { ok: false, error: "Stop this pod's campaigns or transfer its live enrollments before removing the pod." };
    // A scheduled or pending campaign would try to launch into an archived pod every minute, forever.
    const planned = await tx.campaign.count({ where: { podId, status: { in: ['SCHEDULED', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED'] } } });
    if (planned) return { ok: false, error: `${planned === 1 ? 'A campaign is' : `${planned} campaigns are`} scheduled or running in this pod. Stop ${planned === 1 ? 'it' : 'them'} first.` };
    await tx.pod.update({ where: { id: podId }, data: { archived: true } });
    await logAudit({ entityType: 'pod', entityId: podId, action: 'archived', actor: userActor(admin) }, tx);
    return { ok: true, message: 'Pod removed. History retained.' };
  });
  if (!result.ok) return result;
  refresh();
  return result;
}

export async function restorePodAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const podId = String(formData.get('podId') ?? '');
  if (!(await prisma.pod.findUnique({ where: { id: podId } }))) return { ok: false, error: 'Pod not found.' };
  await prisma.pod.update({ where: { id: podId }, data: { archived: false } });
  await logAudit({ entityType: 'pod', entityId: podId, action: 'restored', actor: userActor(admin) });
  refresh();
  return { ok: true, message: 'Pod restored.' };
}
