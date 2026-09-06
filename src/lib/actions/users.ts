'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAdmin } from '../auth/current-user';
import { hashPassword, validatePasswordStrength } from '../auth/password';
import { logAudit, userActor } from '../audit';

export type ActionResult = { ok: true; message?: string; redirectTo?: string; data?: unknown } | { ok: false; error: string };

const RoleSchema = z.enum(['ADMIN', 'SENIOR_FO', 'JUNIOR_FO']);

const CreateUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1),
  password: z.string().min(8),
  role: RoleSchema,
  timezone: z.string().trim().min(1).default('Europe/London'),
  twentyMemberId: z.string().trim().optional().transform((v) => (v ? v : null)),
  aliases: z.string().optional().transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  podIds: z.array(z.string()).default([]),
  dailyCap: z.coerce.number().int().positive().optional().nullable(),
});

function formToObject(formData: FormData) {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (k === 'podIds') {
      (obj.podIds as string[] | undefined) ? (obj.podIds as string[]).push(String(v)) : (obj.podIds = [String(v)]);
    } else {
      obj[k] = typeof v === 'string' ? v : undefined;
    }
  }
  if (obj.dailyCap === '') obj.dailyCap = null;
  return obj;
}

export async function createUserAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = CreateUserSchema.safeParse(formToObject(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const d = parsed.data;
  const weak = validatePasswordStrength(d.password);
  if (weak) return { ok: false, error: weak };
  if (await prisma.user.findUnique({ where: { email: d.email } })) return { ok: false, error: 'A user with that email already exists.' };
  if (d.twentyMemberId && (await prisma.user.findUnique({ where: { twentyMemberId: d.twentyMemberId } }))) {
    return { ok: false, error: 'Another user is already mapped to that Twenty workspace member.' };
  }
  const user = await prisma.user.create({
    data: {
      email: d.email,
      name: d.name,
      role: d.role,
      passwordHash: await hashPassword(d.password),
      timezone: d.timezone,
      twentyMemberId: d.twentyMemberId,
      aliases: d.aliases,
      dailyCap: d.dailyCap ?? null,
      pods: { create: d.podIds.map((podId) => ({ podId })) },
    },
  });
  await logAudit({ entityType: 'user', entityId: user.id, action: 'created', actor: userActor(admin), details: { role: d.role, pods: d.podIds } });
  revalidatePath('/settings');
  return { ok: true, message: `Created ${user.name}.` };
}

const UpdateUserSchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(1),
  role: RoleSchema,
  timezone: z.string().trim().min(1),
  twentyMemberId: z.string().trim().optional().transform((v) => (v ? v : null)),
  aliases: z.string().optional().transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  podIds: z.array(z.string()).default([]),
  dailyCap: z.coerce.number().int().positive().optional().nullable(),
  active: z.string().optional().transform((v) => v === 'on' || v === 'true'),
  password: z.string().optional(),
});

export async function updateUserAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = UpdateUserSchema.safeParse(formToObject(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const d = parsed.data;
  const existing = await prisma.user.findUnique({ where: { id: d.userId } });
  if (!existing) return { ok: false, error: 'User not found.' };
  if (existing.id === admin.id && (d.role !== 'ADMIN' || !d.active)) {
    return { ok: false, error: 'You cannot demote or deactivate your own account.' };
  }
  if (d.twentyMemberId) {
    const clash = await prisma.user.findUnique({ where: { twentyMemberId: d.twentyMemberId } });
    if (clash && clash.id !== d.userId) return { ok: false, error: 'Another user is already mapped to that Twenty workspace member.' };
  }
  let passwordHash: string | undefined;
  if (d.password) {
    const weak = validatePasswordStrength(d.password);
    if (weak) return { ok: false, error: weak };
    passwordHash = await hashPassword(d.password);
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: d.userId },
      data: {
        name: d.name,
        role: d.role,
        timezone: d.timezone,
        twentyMemberId: d.twentyMemberId,
        aliases: d.aliases,
        dailyCap: d.dailyCap ?? null,
        active: d.active,
        ...(passwordHash ? { passwordHash } : {}),
      },
    });
    await tx.userPod.deleteMany({ where: { userId: d.userId } });
    if (d.podIds.length) await tx.userPod.createMany({ data: d.podIds.map((podId) => ({ userId: d.userId, podId })) });
    if (!d.active) await tx.session.deleteMany({ where: { userId: d.userId } });
    await logAudit(
      { entityType: 'user', entityId: d.userId, action: 'updated', actor: userActor(admin), details: { role: d.role, pods: d.podIds, active: d.active, passwordReset: Boolean(passwordHash) } },
      tx,
    );
  });
  revalidatePath('/settings');
  return { ok: true, message: `Saved ${d.name}.` };
}

const PodSchema = z.object({ name: z.string().trim().min(1), podOwnerValue: z.string().trim().min(1) });

export async function createPodAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = PodSchema.safeParse({ name: formData.get('name'), podOwnerValue: formData.get('podOwnerValue') });
  if (!parsed.success) return { ok: false, error: 'Pod name and podOwner value are required.' };
  const exists = await prisma.pod.findFirst({ where: { OR: [{ name: parsed.data.name }, { podOwnerValue: parsed.data.podOwnerValue }] } });
  if (exists) return { ok: false, error: 'A pod with that name or podOwner value already exists.' };
  const pod = await prisma.pod.create({ data: parsed.data });
  await logAudit({ entityType: 'pod', entityId: pod.id, action: 'created', actor: userActor(admin), details: parsed.data });
  revalidatePath('/settings');
  return { ok: true, message: `Created pod ${pod.name}.` };
}

export async function deletePodAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const podId = String(formData.get('podId') ?? '');
  const inUse = await prisma.campaign.count({ where: { podId } });
  if (inUse) return { ok: false, error: 'Pod has campaigns; stop and remove them first.' };
  await prisma.pod.delete({ where: { id: podId } });
  await logAudit({ entityType: 'pod', entityId: podId, action: 'deleted', actor: userActor(admin) });
  revalidatePath('/settings');
  return { ok: true, message: 'Pod deleted.' };
}
