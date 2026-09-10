import 'dotenv/config';
import { WORKSPACE_TIMEZONE } from '../src/lib/workspace';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';
import { hashPassword } from '../src/lib/auth/password';
import { DEFAULT_SEQUENCE_NAME, DEFAULT_SEQUENCE_STEPS } from '../src/lib/sequences/default-sequence';
import { StepsSchema } from '../src/lib/sequences/steps';
import { logAudit, SYSTEM_ACTOR } from '../src/lib/audit';


/** Core: the default sequence (version 1, exactly as specified) and the admin account. */
async function seedCore() {
  const steps = StepsSchema.parse(DEFAULT_SEQUENCE_STEPS);
  let sequence = await prisma.sequence.findUnique({ where: { name: DEFAULT_SEQUENCE_NAME } });
  if (!sequence) {
    sequence = await prisma.sequence.create({ data: { name: DEFAULT_SEQUENCE_NAME, steps } });
    await logAudit({ entityType: 'sequence', entityId: sequence.id, action: 'seeded', actor: SYSTEM_ACTOR, details: { steps: steps.length } });
    console.log(`  + sequence "${DEFAULT_SEQUENCE_NAME}" (${steps.length} steps)`);
  } else {
    console.log(`  = sequence "${DEFAULT_SEQUENCE_NAME}" exists`);
  }

  const e = env();
  const adminEmail = e.ADMIN_EMAIL.toLowerCase();
  if (!(await prisma.user.findUnique({ where: { email: adminEmail } }))) {
    // Refused rather than defaulted: an account created with a password nobody chose is an
    // account whose password everybody knows.
    if (!e.ADMIN_PASSWORD) throw new Error('Set ADMIN_PASSWORD in .env before seeding: it is the password for the first account.');
    await prisma.user.create({ data: { email: adminEmail, name: 'Admin', role: 'ADMIN', passwordHash: await hashPassword(e.ADMIN_PASSWORD), timezone: WORKSPACE_TIMEZONE } });
    console.log(`  + admin user ${adminEmail}`);
  } else {
    console.log(`  = admin user ${adminEmail} exists`);
  }
  return sequence;
}

async function main() {
  const profiles = env().SEED_PROFILE.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  console.log(`[seed] profiles: ${profiles.join(', ')}`);
  let sequenceId: string | null = null;
  if (profiles.includes('core')) {
    console.log('[seed] core');
    sequenceId = (await seedCore()).id;
  }
  const demo = profiles.includes('demo') ? 'demo' : profiles.includes('demo-basic') ? 'demo-basic' : null;
  if (demo) {
    if (env().TWENTY_MODE !== 'mock' || env().CADENCE_ALLOW_MOCK !== '1') {
      console.log(`[seed] ${demo} profile skipped: TWENTY_MODE is not mock (people come from your Twenty workspace).`);
    } else {
      console.log(`[seed] ${demo}`);
      const seq = sequenceId ?? (await prisma.sequence.findFirst({ where: { archived: false } }))?.id;
      if (!seq) throw new Error('demo profile needs a sequence; include "core" in SEED_PROFILE');
      // Loaded only here, so nothing in the production path so much as imports the sample data.
      const { seedDemo } = await import('./seed-demo');
      await seedDemo(seq, demo === 'demo');
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
