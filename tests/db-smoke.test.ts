import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getSettings, saveSettingsSection } from '@/lib/settings';

describe('database', () => {
  let basics: Basics;
  beforeAll(async () => {
    await resetDb();
    basics = await seedBasics();
  });

  it('applies migrations and seeds the basics', async () => {
    expect(await prisma.pod.count()).toBe(3);
    expect(await prisma.user.count()).toBe(6);
    expect(await prisma.personCache.count()).toBe(40);
    const seq = await prisma.sequence.findUniqueOrThrow({ where: { id: basics.sequence.id }, include: { activeVersion: true } });
    expect(seq.activeVersion?.version).toBe(1);
  });

  it('enforces one active enrollment per person at the database level', async () => {
    const base = {
      personId: 'person-01',
      foUserId: basics.users.alisa.id,
      sequenceId: basics.sequence.id,
      sequenceVersionId: basics.version.id,
      startDate: '2026-09-07',
    };
    await prisma.enrollment.create({ data: { ...base, status: 'ACTIVE' } });
    await expect(prisma.enrollment.create({ data: { ...base, status: 'PAUSED' } })).rejects.toThrow();
    // A finished enrollment does not occupy the slot.
    await prisma.enrollment.updateMany({ where: { personId: 'person-01' }, data: { status: 'EXITED' } });
    await expect(prisma.enrollment.create({ data: { ...base, status: 'ACTIVE' } })).resolves.toBeTruthy();
  });

  it('stores and reloads settings with defaults', async () => {
    const before = await getSettings();
    expect(before.rules.dailyCap).toBe(40);
    await saveSettingsSection('rules', { ...before.rules, dailyCap: 25, clockMode: 'hold' });
    const after = await getSettings();
    expect(after.rules.dailyCap).toBe(25);
    expect(after.rules.clockMode).toBe('hold');
    expect(after.matching.outboundEmailTitle).toContain('Outbound email');
  });
});
