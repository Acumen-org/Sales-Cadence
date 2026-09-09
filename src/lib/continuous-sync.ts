import { randomBytes } from 'node:crypto';
import { prisma } from './db';
import { hashPassword } from './auth/password';
import { WORKSPACE_TIMEZONE } from './workspace';
import { getTwentyClient } from './twenty';
import { refreshPersonCache } from './person-cache';
import { reconcile } from './engine/reconcile';
import { SYSTEM_ACTOR } from './audit';
import type { TwentyClient } from './twenty/client';

/** Discover CRM members without granting login access or restoring removed users. */
export async function syncWorkspaceMembers(client: TwentyClient) {
  const members = await client.listWorkspaceMembers();
  for (const member of members) {
    const email = member.email?.trim().toLowerCase(); if (!email) continue;
    const existing = await prisma.user.findFirst({ where: { OR: [{ twentyMemberId: member.id }, { email }] } });
    if (existing) {
      if (!existing.twentyMemberId) await prisma.user.updateMany({ where: { id: existing.id, twentyMemberId: null }, data: { twentyMemberId: member.id, timezone: WORKSPACE_TIMEZONE } });
    } else {
      await prisma.user.upsert({ where: { email }, create: { email, name: [member.firstName,member.lastName].filter(Boolean).join(' ') || email, twentyMemberId: member.id, timezone: WORKSPACE_TIMEZONE, role: 'JUNIOR_FO', active: false, passwordHash: await hashPassword(randomBytes(32).toString('hex')) }, update: {} });
    }
  }
}

export async function syncContinuously(now = new Date()) {
  const previous = await prisma.setting.findUnique({ where: { key: 'continuousSync' } });
  const state = previous?.value as { watermark?: string; lastSuccess?: string; lastError?: string } | null;
  try {
    const client = await getTwentyClient();
    if (!state?.watermark) await refreshPersonCache(client);
    await syncWorkspaceMembers(client);
    const watermark = state?.watermark ? new Date(state.watermark).getTime() : now.getTime() - 14 * 86400000;
    const since = new Date(watermark - 10 * 60000).toISOString();
    const result = await reconcile({ since, now, actor: SYSTEM_ACTOR }, client);
    if (result.errors) throw new Error(`${result.errors} CRM events need review`);
    const value = { watermark: now.toISOString(), lastSuccess: now.toISOString(), lastError: null };
    await prisma.setting.upsert({ where: { key: 'continuousSync' }, create: { key: 'continuousSync', value }, update: { value } });
    return result;
  } catch (error) {
    const value = { watermark: state?.watermark ?? null, lastSuccess: state?.lastSuccess ?? null, lastError: error instanceof Error ? error.message : 'CRM sync failed', attemptedAt: now.toISOString() };
    await prisma.setting.upsert({ where: { key: 'continuousSync' }, create: { key: 'continuousSync', value }, update: { value } });
    throw error;
  }
}
