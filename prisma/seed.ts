import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';
import { hashPassword } from '../src/lib/auth/password';
import { DEFAULT_SEQUENCE_DESCRIPTION, DEFAULT_SEQUENCE_NAME, DEFAULT_SEQUENCE_STEPS } from '../src/lib/sequences/default-sequence';
import { StepsSchema } from '../src/lib/sequences/steps';
import { DEMO_MEMBERS, DEMO_POD_OPTIONS } from '../src/lib/twenty/demo-fixtures';
import { getMockTwentyClient } from '../src/lib/twenty/mock-client';
import { ensurePod, refreshPersonCache } from '../src/lib/person-cache';
import { logAudit, SYSTEM_ACTOR } from '../src/lib/audit';
import { addDays, todayIn } from '../src/lib/dates';
import { nextWorkingDay } from '../src/lib/engine/clock';
import { enrollPeople } from '../src/lib/engine/enrollment';
import { completeCall, skipWithReason } from '../src/lib/engine/outcomes';
import { completeTask } from '../src/lib/engine/tasks';
import { reconcile } from '../src/lib/engine/reconcile';
import { getSettings } from '../src/lib/settings';

const DEMO_PASSWORD = 'password123';

/** Core: the default sequence (version 1, exactly as specified) and the admin account. */
async function seedCore() {
  const steps = StepsSchema.parse(DEFAULT_SEQUENCE_STEPS);
  let sequence = await prisma.sequence.findUnique({ where: { name: DEFAULT_SEQUENCE_NAME } });
  if (!sequence) {
    sequence = await prisma.sequence.create({ data: { name: DEFAULT_SEQUENCE_NAME, description: DEFAULT_SEQUENCE_DESCRIPTION } });
    const version = await prisma.sequenceVersion.create({ data: { sequenceId: sequence.id, version: 1, steps, changeNote: 'Seeded default sequence' } });
    await prisma.sequence.update({ where: { id: sequence.id }, data: { activeVersionId: version.id } });
    await logAudit({ entityType: 'sequence', entityId: sequence.id, action: 'seeded', actor: SYSTEM_ACTOR, details: { version: 1 } });
    console.log(`  + sequence "${DEFAULT_SEQUENCE_NAME}" v1 (${steps.length} steps)`);
  } else {
    console.log(`  = sequence "${DEFAULT_SEQUENCE_NAME}" exists`);
  }

  const e = env();
  const adminEmail = e.ADMIN_EMAIL.toLowerCase();
  if (!(await prisma.user.findUnique({ where: { email: adminEmail } }))) {
    await prisma.user.create({ data: { email: adminEmail, name: 'Admin', role: 'ADMIN', passwordHash: await hashPassword(e.ADMIN_PASSWORD), timezone: 'Europe/London' } });
    console.log(`  + admin user ${adminEmail}`);
  } else {
    console.log(`  = admin user ${adminEmail} exists`);
  }
  return sequence;
}

/**
 * Demo (mock mode only): one dummy record of everything.
 * Pods come from the mock workspace's podOwner options (Alisa's pod, Andrew's pod); the person
 * whose podOwner is "Karson" shows pod discovery. One user per role. A campaign per pod with
 * enrollments in every state: active, overdue, replied, bounced, finished, meeting.
 */
async function seedDemo(sequenceId: string, withCampaigns: boolean) {
  const client = getMockTwentyClient();

  // Pods and people from the (mock) CRM, exactly as a real refresh would do it.
  for (const opt of DEMO_POD_OPTIONS.filter((o) => o.value !== 'Karson')) await ensurePod(opt.value, opt.label);
  const cache = await refreshPersonCache(client);
  console.log(`  + pods synced from Twenty options; ${cache.people} dummy people, ${cache.companies} dummy companies cached`);

  const pod = async (value: string) => (await prisma.pod.findUniqueOrThrow({ where: { podOwnerValue: value } })).id;
  const users: Array<{ memberId: string; email: string; name: string; role: 'ADMIN' | 'SENIOR_FO' | 'JUNIOR_FO'; pods: string[] }> = [
    { memberId: 'wm-ria', email: 'ria@cadence.local', name: 'Ria Admin', role: 'ADMIN', pods: [] },
    { memberId: 'wm-alisa', email: 'alisa@cadence.local', name: 'Alisa Senior', role: 'SENIOR_FO', pods: ['Alisa'] },
    { memberId: 'wm-andrew', email: 'andrew@cadence.local', name: 'Andrew Senior', role: 'SENIOR_FO', pods: ['Andrew'] },
    { memberId: 'wm-karson', email: 'karson@cadence.local', name: 'Karson Junior', role: 'JUNIOR_FO', pods: ['Alisa'] },
    { memberId: 'wm-daniel', email: 'daniel@cadence.local', name: 'Daniel Junior', role: 'JUNIOR_FO', pods: ['Andrew'] },
  ];
  const hash = await hashPassword(DEMO_PASSWORD);
  const byEmail = new Map<string, string>();
  for (const u of users) {
    const member = DEMO_MEMBERS.find((m) => m.id === u.memberId)!;
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, name: u.name, role: u.role, passwordHash: hash, twentyMemberId: member.id, aliases: [`tw_${member.firstName.toLowerCase()}`], timezone: 'Europe/London' },
      update: { twentyMemberId: member.id, aliases: [`tw_${member.firstName.toLowerCase()}`] },
    });
    byEmail.set(u.email, user.id);
    for (const p of u.pods) {
      const podId = await pod(p);
      await prisma.userPod.upsert({ where: { userId_podId: { userId: user.id, podId } }, create: { userId: user.id, podId }, update: {} });
    }
  }
  console.log(`  + ${users.length} demo users (password: ${DEMO_PASSWORD})`);

  if (!withCampaigns) {
    console.log('  = demo-basic: no campaigns seeded');
    return;
  }
  if (await prisma.campaign.count()) {
    console.log('  = demo campaigns exist, leaving enrollments alone');
    return;
  }

  // A campaign per pod, started last week so today shows work due, overdue and done.
  const settings = await getSettings();
  const today = todayIn('Europe/London');
  const startDate = nextWorkingDay(addDays(today, -7), settings.rules.workingDays);
  const at = (offsetDays: number) => new Date(`${addDays(startDate, offsetDays)}T10:00:00Z`);

  const campaignA = await prisma.campaign.create({
    data: { name: 'Dummy campaign - Alisa\'s pod', sequenceId, podId: await pod('Alisa'), sourceType: 'TWENTY_VIEW', sourceRef: "Alisa's pod - all people (view-alisa-pod)", personIds: ['dummy-01', 'dummy-02', 'dummy-03', 'dummy-04', 'dummy-05'], startDate, status: 'ACTIVE', notes: 'Seeded dummy data' },
  });
  const a = await enrollPeople(
    { personIds: ['dummy-01', 'dummy-02', 'dummy-03', 'dummy-04', 'dummy-05', 'dummy-06'], sequenceId, podId: campaignA.podId, campaignId: campaignA.id, startDate, assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR },
    { now: at(0) },
  );
  console.log(`  + ${a.enrolled.length} enrolled in "${campaignA.name}" (${a.conflicts.length} skipped: ${a.conflicts.map((c) => `${c.name} ${c.reason}`).join(', ')})`);

  const campaignB = await prisma.campaign.create({
    data: { name: 'Dummy campaign - Andrew\'s pod', sequenceId, podId: await pod('Andrew'), sourceType: 'IDS', sourceRef: 'pasted ids', personIds: ['dummy-07', 'dummy-08', 'dummy-09', 'dummy-10'], startDate: today, status: 'ACTIVE', notes: 'Seeded dummy data' },
  });
  const b = await enrollPeople(
    { personIds: ['dummy-07', 'dummy-08', 'dummy-09', 'dummy-10'], sequenceId, podId: campaignB.podId, campaignId: campaignB.id, startDate: today, assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR },
    { now: new Date() },
  );
  console.log(`  + ${b.enrolled.length} enrolled in "${campaignB.name}"`);

  // Replay the dummy Twenty activity: Dummy One's email note completes Email 1, Dummy Two's reply
  // finishes as replied, the opportunity on Dummy Eight books a meeting. The fixture timestamps are
  // moved to the last day or two so they count as evidence for enrollments created just now.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  client.notes.forEach((n, i) => {
    n.createdAt = hoursAgo(6 - i);
    n.updatedAt = n.createdAt;
  });
  client.messages.forEach((m, i) => {
    m.receivedAt = hoursAgo(5 - i * 2);
    m.updatedAt = m.receivedAt;
  });
  client.opportunities.forEach((o) => {
    o.createdAt = hoursAgo(2);
    o.updatedAt = o.createdAt;
  });
  const rec = await reconcile({ days: 60, actor: SYSTEM_ACTOR, now: new Date() }, client);
  console.log(`  + reconciled dummy activity: ${rec.completions} completions, ${rec.replies} replies, ${rec.meetings} meetings`);

  const pendingFor = (personId: string) => prisma.task.findMany({ where: { enrollment: { personId }, state: 'PENDING' }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }] });
  const ctx = { actor: SYSTEM_ACTOR, now: at(1) };

  // Dummy One: finish step 1 by hand (LinkedIn) so Call 1 is due; then log a voicemail
  for (const t of await pendingFor('dummy-01')) if (t.action === 'LINKEDIN_CONNECT') await completeTask({ taskId: t.id, source: 'MANUAL' }, ctx);
  const call = (await pendingFor('dummy-01')).find((t) => t.action === 'CALL');
  if (call) await completeCall({ taskId: call.id, disposition: 'voicemail', note: 'Dummy voicemail left, call back Thursday.' }, { actor: SYSTEM_ACTOR, now: at(2) });

  // Dummy Three: email bounced -> Bounced
  const three = (await pendingFor('dummy-03')).find((t) => t.action === 'EMAIL');
  if (three) await skipWithReason({ taskId: three.id, reasonKey: 'bounced', note: 'Dummy bounce: mailbox not found.' }, ctx);

  // Dummy Four: on time through step 1 (owner Karson) so step 2 is due today-ish
  for (const t of await pendingFor('dummy-04')) await completeTask({ taskId: t.id, source: 'MANUAL' }, ctx);
  // Dummy Five: untouched -> overdue. Dummy Six: dnd -> never enrolled. Andrew's pod: due today.
  console.log('  + states: Dummy One (call logged), Two (replied), Three (bounced), Four (call due), Five (overdue), Six (dnd), Eight (meeting)');
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
    if (env().TWENTY_MODE !== 'mock') {
      console.log(`[seed] ${demo} profile skipped: TWENTY_MODE is not mock (people come from your Twenty workspace).`);
    } else {
      console.log(`[seed] ${demo}`);
      const seq = sequenceId ?? (await prisma.sequence.findFirst({ where: { archived: false } }))?.id;
      if (!seq) throw new Error('demo profile needs a sequence; include "core" in SEED_PROFILE');
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
