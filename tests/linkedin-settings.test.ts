import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { saveLinkedInKeyAction, saveLinkedInSettingsAction } = await import('@/lib/actions/settings');
const { consoleKey } = await import('@/lib/linkedin/console');
const { resetEnvCache } = await import('@/lib/env');

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
    expect((await getSettings()).linkedin).toEqual({ ...VALID, consoleApiKey: '' });
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

/** Settings > LinkedIn: the Console's feed key, entered here (owner, 17 Nov 2026), kept only if the Console accepts it. */
describe('LinkedIn feed key in Settings', () => {
  let b: Basics;
  const answers = vi.fn();
  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    auth.user.mockResolvedValue(asUser(b.users.ria));
    vi.stubEnv('LINKEDIN_CONSOLE_URL', 'https://console.example');
    vi.stubEnv('LINKEDIN_CONSOLE_API_KEY', '');
    resetEnvCache();
    answers.mockReset();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string> }) => answers(init.headers.authorization)));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvCache(); });
  const ok = () => new Response(JSON.stringify({ accounts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), { status: 200 });

  it('a key the Console accepts is kept, never audited in full, and survives saving the rules', async () => {
    answers.mockImplementation(async (auth: string) => (auth === 'Bearer ext_good' ? ok() : new Response('{}', { status: 401 })));
    expect(await saveLinkedInKeyAction(form({ consoleApiKey: 'ext_bad' }))).toEqual({ ok: false, error: 'The LinkedIn Console refused the feed key (wrong, or revoked).' });
    expect(await consoleKey()).toBeNull();
    expect(await saveLinkedInKeyAction(form({ consoleApiKey: ' ext_good ' }))).toMatchObject({ ok: true, message: expect.stringContaining('3 LinkedIn accounts') });
    expect(await consoleKey()).toEqual({ key: 'ext_good', from: 'settings' });
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'settings', entityId: 'linkedin' } });
    expect(JSON.stringify(audits)).not.toContain('ext_good');
    await saveLinkedInSettingsAction(form(VALID));
    invalidateSettingsCache();
    expect(await consoleKey()).toEqual({ key: 'ext_good', from: 'settings' });
    expect(await saveLinkedInKeyAction(form({ remove: '1' }))).toEqual({ ok: true, message: 'Feed key removed.' });
    expect(await consoleKey()).toBeNull();
  });

  it('a key on the server wins; only an admin sets one', async () => {
    vi.stubEnv('LINKEDIN_CONSOLE_API_KEY', 'ext_server');
    resetEnvCache();
    expect(await consoleKey()).toEqual({ key: 'ext_server', from: 'server' });
    auth.user.mockResolvedValue(asUser(b.users.alisa));
    await expect(saveLinkedInKeyAction(form({ consoleApiKey: 'ext_good' }))).rejects.toThrow('Admin only.');
  });
});
