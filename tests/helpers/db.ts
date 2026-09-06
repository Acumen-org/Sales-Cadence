import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { DEFAULT_SEQUENCE_NAME, DEFAULT_SEQUENCE_STEPS } from '@/lib/sequences/default-sequence';
import { MOCK_MEMBERS, MOCK_PEOPLE, MOCK_PODS } from '@/lib/twenty/fixtures';
import { upsertPersonCache } from '@/lib/person-cache';
import { invalidateSettingsCache } from '@/lib/settings';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';

const TABLES = [
  'AuditLog',
  'TwentyWrite',
  'ActivityEvent',
  'Touch',
  'Task',
  'Enrollment',
  'Campaign',
  'Session',
  'UserPod',
  'Setting',
  'CompanyCache',
  'PersonCache',
  'Sequence',
  'SequenceVersion',
  'User',
  'Pod',
];

/** Empty every table (fast TRUNCATE) and reset the mock Twenty workspace. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  invalidateSettingsCache();
  getMockTwentyClient().reset();
}

export type Basics = Awaited<ReturnType<typeof seedBasics>>;

/**
 * Pods Alisa/Leigh/Andrew, users mapped to the mock workspace members,
 * the default sequence at version 1, and all 40 mock people cached.
 */
export async function seedBasics() {
  const hash = await hashPassword('password123');
  const pods: Record<string, { id: string; name: string }> = {};
  for (const name of MOCK_PODS) {
    pods[name] = await prisma.pod.create({ data: { name: `Pod ${name}`, podOwnerValue: name } });
  }
  const mk = async (memberId: string, role: 'ADMIN' | 'SENIOR_FO' | 'JUNIOR_FO', podNames: string[]) => {
    const m = MOCK_MEMBERS.find((x) => x.id === memberId)!;
    const user = await prisma.user.create({
      data: {
        email: `${m.firstName.toLowerCase()}@cadence.local`,
        name: `${m.firstName} ${m.lastName}`,
        role,
        passwordHash: hash,
        twentyMemberId: m.id,
        aliases: [`tw_${m.firstName.toLowerCase()}`],
        timezone: 'Europe/London',
        pods: { create: podNames.map((p) => ({ podId: pods[p].id })) },
      },
    });
    return user;
  };
  const alisa = await mk('wm-alisa', 'SENIOR_FO', ['Alisa']);
  const leigh = await mk('wm-leigh', 'SENIOR_FO', ['Leigh']);
  const andrew = await mk('wm-andrew', 'SENIOR_FO', ['Andrew']);
  const karson = await mk('wm-karson', 'JUNIOR_FO', ['Alisa']);
  const daniel = await mk('wm-daniel', 'JUNIOR_FO', ['Leigh']);
  const ria = await mk('wm-ria', 'ADMIN', []);

  const sequence = await prisma.sequence.create({ data: { name: DEFAULT_SEQUENCE_NAME } });
  const version = await prisma.sequenceVersion.create({
    data: { sequenceId: sequence.id, version: 1, steps: DEFAULT_SEQUENCE_STEPS },
  });
  await prisma.sequence.update({ where: { id: sequence.id }, data: { activeVersionId: version.id } });

  for (const p of MOCK_PEOPLE) await upsertPersonCache(p);

  return { pods, users: { alisa, leigh, andrew, karson, daniel, ria }, sequence, version };
}
