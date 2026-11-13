import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { DEFAULT_SETTINGS, getSettings, invalidateSettingsCache } from '@/lib/settings';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', async () => {
  const { ForbiddenError, isAdmin } = await import('@/lib/auth/rbac');
  return {
    requireUser: auth.user,
    // As the real one: anyone but an admin is refused.
    requireAdmin: async () => {
      const user = await auth.user();
      if (!isAdmin(user)) throw new ForbiddenError('Admin only.');
      return user;
    },
    toActor: (user: SessionUser) => user,
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const { saveLinkedInSettingsAction } = await import('@/lib/actions/settings');

const asUser = (user: User): SessionUser => ({ ...user, podIds: [], pods: [] });

const form = (values: Record<string, string | number | boolean>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === false) continue;
    fd.set(k, v === true ? 'on' : String(v));
  }
  return fd;
};

const VALID = { enabled: true, withdrawAfterDays: 21, resendAfterDays: 28, maxResends: 2, messageAfterAcceptDays: 3, inviteWeeklyLimit: 60 };

/** Settings > LinkedIn: the rules for the tasks Cadence opens from what the LinkedIn Console reports. */
describe('LinkedIn settings', () => {
  let b: Basics;

  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    auth.user.mockResolvedValue(asUser(b.users.ria));
  });

  it('an admin saves the rules, and the change is audited', async () => {
    const r = await saveLinkedInSettingsAction(form(VALID));
    expect(r).toEqual({ ok: true, message: 'LinkedIn settings saved.' });
    invalidateSettingsCache();
    expect((await getSettings()).linkedin).toEqual(VALID);
    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'settings', entityId: 'linkedin', action: 'updated' } });
    expect(audit).not.toBeNull();
  });

  it('an unticked box turns LinkedIn handling off', async () => {
    const r = await saveLinkedInSettingsAction(form({ ...VALID, enabled: false }));
    expect(r.ok).toBe(true);
    invalidateSettingsCache();
    expect((await getSettings()).linkedin.enabled).toBe(false);
  });

  it('refuses a value out of range, in plain words, and saves nothing', async () => {
    const tooSoon = await saveLinkedInSettingsAction(form({ ...VALID, withdrawAfterDays: 3 }));
    expect(tooSoon).toEqual({ ok: false, error: 'Withdraw a request after must be at least 7.' });
    const tooMany = await saveLinkedInSettingsAction(form({ ...VALID, maxResends: 5, inviteWeeklyLimit: 500 }));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.error).toContain('Times to send again must be at most 3.');
      expect(tooMany.error).toContain('Requests per account per week must be at most 200.');
    }
    const notWhole = await saveLinkedInSettingsAction(form({ ...VALID, resendAfterDays: 21.5 }));
    expect(notWhole.ok).toBe(false);
    expect(await prisma.setting.findUnique({ where: { key: 'linkedin' } })).toBeNull();
    invalidateSettingsCache();
    expect((await getSettings()).linkedin).toEqual(DEFAULT_SETTINGS.linkedin);
  });

  it('refuses anyone who is not an admin', async () => {
    auth.user.mockResolvedValue(asUser(b.users.alisa));
    await expect(saveLinkedInSettingsAction(form(VALID))).rejects.toThrow('Admin only.');
    expect(await prisma.setting.findUnique({ where: { key: 'linkedin' } })).toBeNull();
  });
});
