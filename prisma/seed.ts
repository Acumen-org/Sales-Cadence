import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';
import { hashPassword } from '../src/lib/auth/password';
import { DEFAULT_SEQUENCE_DESCRIPTION, DEFAULT_SEQUENCE_NAME, DEFAULT_SEQUENCE_STEPS } from '../src/lib/sequences/default-sequence';
import { StepsSchema } from '../src/lib/sequences/steps';
import { MOCK_COMPANIES, MOCK_MEMBERS, MOCK_PEOPLE, MOCK_PODS } from '../src/lib/twenty/fixtures';
import { upsertCompanyCache, upsertPersonCache } from '../src/lib/person-cache';
import { logAudit, SYSTEM_ACTOR } from '../src/lib/audit';

const DEMO_PASSWORD = 'password123';

/** Core: the default sequence (version 1, exactly as specified) and the admin account. */
async function seedCore() {
  const steps = StepsSchema.parse(DEFAULT_SEQUENCE_STEPS);
  let sequence = await prisma.sequence.findUnique({ where: { name: DEFAULT_SEQUENCE_NAME } });
  if (!sequence) {
    sequence = await prisma.sequence.create({ data: { name: DEFAULT_SEQUENCE_NAME, description: DEFAULT_SEQUENCE_DESCRIPTION } });
    const version = await prisma.sequenceVersion.create({
      data: { sequenceId: sequence.id, version: 1, steps, changeNote: 'Seeded default sequence' },
    });
    await prisma.sequence.update({ where: { id: sequence.id }, data: { activeVersionId: version.id } });
    await logAudit({ entityType: 'sequence', entityId: sequence.id, action: 'seeded', actor: SYSTEM_ACTOR, details: { version: 1 } });
    console.log(`  + sequence "${DEFAULT_SEQUENCE_NAME}" v1 (${steps.length} steps)`);
  } else {
    console.log(`  = sequence "${DEFAULT_SEQUENCE_NAME}" exists`);
  }

  const e = env();
  const adminEmail = e.ADMIN_EMAIL.toLowerCase();
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) {
    await prisma.user.create({
      data: { email: adminEmail, name: 'Admin', role: 'ADMIN', passwordHash: await hashPassword(e.ADMIN_PASSWORD), timezone: 'Europe/London' },
    });
    console.log(`  + admin user ${adminEmail}`);
  } else {
    console.log(`  = admin user ${adminEmail} exists`);
  }
}

/** Demo: pods, users mapped to mock workspace members, and the 40 mock people in the cache. */
async function seedDemo() {
  const podByOwner = new Map<string, string>();
  for (const name of MOCK_PODS) {
    const pod = await prisma.pod.upsert({ where: { podOwnerValue: name }, create: { name: `Pod ${name}`, podOwnerValue: name }, update: {} });
    podByOwner.set(name, pod.id);
  }
  console.log(`  + ${MOCK_PODS.length} pods`);

  const users: Array<{ memberId: string; role: 'ADMIN' | 'SENIOR_FO' | 'JUNIOR_FO'; pods: string[] }> = [
    { memberId: 'wm-alisa', role: 'SENIOR_FO', pods: ['Alisa'] },
    { memberId: 'wm-leigh', role: 'SENIOR_FO', pods: ['Leigh'] },
    { memberId: 'wm-andrew', role: 'SENIOR_FO', pods: ['Andrew'] },
    { memberId: 'wm-karson', role: 'JUNIOR_FO', pods: ['Alisa'] },
    { memberId: 'wm-daniel', role: 'JUNIOR_FO', pods: ['Leigh'] },
    { memberId: 'wm-ria', role: 'ADMIN', pods: [] },
  ];
  const hash = await hashPassword(DEMO_PASSWORD);
  for (const u of users) {
    const member = MOCK_MEMBERS.find((m) => m.id === u.memberId)!;
    const email = `${member.firstName.toLowerCase()}@cadence.local`;
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: `${member.firstName} ${member.lastName}`,
        role: u.role,
        passwordHash: hash,
        twentyMemberId: member.id,
        aliases: [`tw_${member.firstName.toLowerCase()}`],
        timezone: member.timeZone ?? 'Europe/London',
      },
      update: { twentyMemberId: member.id, aliases: [`tw_${member.firstName.toLowerCase()}`] },
    });
    for (const podName of u.pods) {
      const podId = podByOwner.get(podName)!;
      await prisma.userPod.upsert({ where: { userId_podId: { userId: user.id, podId } }, create: { userId: user.id, podId }, update: {} });
    }
  }
  console.log(`  + ${users.length} demo users (password: ${DEMO_PASSWORD})`);

  for (const c of MOCK_COMPANIES) await upsertCompanyCache(c);
  for (const p of MOCK_PEOPLE) await upsertPersonCache(p);
  console.log(`  + ${MOCK_COMPANIES.length} companies, ${MOCK_PEOPLE.length} people cached`);
}

async function main() {
  const profiles = env()
    .SEED_PROFILE.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  console.log(`[seed] profiles: ${profiles.join(', ')}`);
  if (profiles.includes('core')) {
    console.log('[seed] core');
    await seedCore();
  }
  if (profiles.includes('demo')) {
    if (env().TWENTY_MODE !== 'mock') {
      console.log('[seed] demo profile skipped: TWENTY_MODE is not mock (people come from your Twenty workspace).');
    } else {
      console.log('[seed] demo');
      await seedDemo();
    }
  }
  console.log('[seed] done');
}

main()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
