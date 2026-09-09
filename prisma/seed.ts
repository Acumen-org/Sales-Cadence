import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';
import { hashPassword } from '../src/lib/auth/password';
import { DEFAULT_SEQUENCE_NAME, DEFAULT_SEQUENCE_STEPS } from '../src/lib/sequences/default-sequence';
import { StepsSchema } from '../src/lib/sequences/steps';
import { DEMO_MEMBERS, DEMO_POD_OPTIONS } from '../src/lib/twenty/demo-fixtures';
import { DEMO_MEETINGS, DEMO_USER_MAILBOXES } from '../src/lib/meetings/demo-meetings';
import { parseMeetingLink } from '../src/lib/meetings/providers';
import { detectTranscriptFormat } from '../src/lib/meetings/transcript';
import { isExternalEmail } from '../src/lib/settings';
import { startOfWeekSunday } from '../src/lib/dates';
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
    sequence = await prisma.sequence.create({ data: { name: DEFAULT_SEQUENCE_NAME, steps } });
    await logAudit({ entityType: 'sequence', entityId: sequence.id, action: 'seeded', actor: SYSTEM_ACTOR, details: { steps: steps.length } });
    console.log(`  + sequence "${DEFAULT_SEQUENCE_NAME}" (${steps.length} steps)`);
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
 * whose podOwner is "KARSON" shows pod discovery. One user per role. A campaign per pod with
 * enrollments in every state: active, overdue, replied, bounced, finished, meeting.
 */
async function seedDemo(sequenceId: string, withCampaigns: boolean) {
  const client = getMockTwentyClient();

  // Pods and people from the (mock) CRM, exactly as a real refresh would do it.
  for (const opt of DEMO_POD_OPTIONS.filter((o) => o.value !== 'KARSON')) await ensurePod(opt.value, opt.label);
  const cache = await refreshPersonCache(client);
  console.log(`  + pods synced from Twenty options; ${cache.people} dummy people, ${cache.companies} dummy companies cached`);

  const pod = async (value: string) => (await prisma.pod.findUniqueOrThrow({ where: { podOwnerValue: value } })).id;
  const users: Array<{ memberId: string; email: string; name: string; role: 'ADMIN' | 'SALES_LEADER' | 'SENIOR_FO' | 'JUNIOR_FO'; pods: string[] }> = [
    { memberId: 'wm-ria', email: 'ria@cadence.local', name: 'Ria Admin', role: 'ADMIN', pods: [] },
    { memberId: 'wm-leigh', email: 'leigh@cadence.local', name: 'Leigh Leader', role: 'SALES_LEADER', pods: ['ALISA', 'ANDREW'] },
    { memberId: 'wm-alisa', email: 'alisa@cadence.local', name: 'Alisa Senior', role: 'SENIOR_FO', pods: ['ALISA'] },
    { memberId: 'wm-andrew', email: 'andrew@cadence.local', name: 'Andrew Senior', role: 'SENIOR_FO', pods: ['ANDREW'] },
    { memberId: 'wm-karson', email: 'karson@cadence.local', name: 'Karson Junior', role: 'JUNIOR_FO', pods: ['ALISA'] },
    { memberId: 'wm-daniel', email: 'daniel@cadence.local', name: 'Daniel Junior', role: 'JUNIOR_FO', pods: ['ANDREW'] },
  ];
  const hash = await hashPassword(DEMO_PASSWORD);
  const byEmail = new Map<string, string>();
  for (const u of users) {
    const member = DEMO_MEMBERS.find((m) => m.id === u.memberId)!;
    // The mailbox alias is how a meeting attendee row is recognised as this colleague.
    const aliases = [`tw_${member.firstName.toLowerCase()}`, DEMO_USER_MAILBOXES[u.email]].filter(Boolean) as string[];
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, name: u.name, role: u.role, passwordHash: hash, twentyMemberId: member.id, aliases, timezone: 'Europe/London' },
      update: { twentyMemberId: member.id, aliases },
    });
    byEmail.set(u.email, user.id);
    for (const p of u.pods) {
      const podId = await pod(p);
      await prisma.userPod.upsert({ where: { userId_podId: { userId: user.id, podId } }, create: { userId: user.id, podId }, update: {} });
    }
  }
  console.log(`  + ${users.length} demo users (password: ${DEMO_PASSWORD})`);
  await seedMeetings();

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
    data: { name: 'Dummy campaign - Alisa\'s pod', sequenceId, podId: await pod('ALISA'), sourceType: 'TWENTY_VIEW', sourceRef: "Alisa's pod - all people (view-alisa-pod)", personIds: ['dummy-01', 'dummy-02', 'dummy-03', 'dummy-04', 'dummy-05'], startDate, status: 'ACTIVE', notes: 'Seeded dummy data' },
  });
  const a = await enrollPeople(
    { personIds: ['dummy-01', 'dummy-02', 'dummy-03', 'dummy-04', 'dummy-05', 'dummy-06'], sequenceId, podId: campaignA.podId, campaignId: campaignA.id, startDate, assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR },
    { now: at(0) },
  );
  console.log(`  + ${a.enrolled.length} enrolled in "${campaignA.name}" (${a.conflicts.length} skipped: ${a.conflicts.map((c) => `${c.name} ${c.reason}`).join(', ')})`);

  const campaignB = await prisma.campaign.create({
    data: { name: "Dummy campaign - Andrew's pod", sequenceId, podId: await pod('ANDREW'), sourceType: 'IDS', sourceRef: 'pasted ids', personIds: ['dummy-07', 'dummy-08', 'dummy-09', 'dummy-10'], startDate, status: 'ACTIVE', notes: 'Seeded dummy data' },
  });
  const b = await enrollPeople(
    { personIds: ['dummy-07', 'dummy-08', 'dummy-09', 'dummy-10'], sequenceId, podId: campaignB.podId, campaignId: campaignB.id, startDate, assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR },
    { now: at(0) },
  );
  console.log(`  + ${b.enrolled.length} enrolled in "${campaignB.name}"`);

  // A fresh campaign per pod starting today, so every FO has work due today.
  for (const [podValue, ids] of [
    ['ALISA', ['dummy-13', 'dummy-14']],
    ['ANDREW', ['dummy-15', 'dummy-16']],
  ] as const) {
    const c = await prisma.campaign.create({
      data: {
        name: `Dummy campaign - starting today (${podValue})`,
        sequenceId,
        podId: await pod(podValue),
        sourceType: 'TWENTY_VIEW',
        sourceRef: 'All dummy people (view-all-dummies)',
        personIds: [...ids],
        startDate: today,
        status: 'ACTIVE',
        notes: 'Seeded dummy data',
      },
    });
    const r = await enrollPeople(
      { personIds: [...ids], sequenceId, podId: c.podId, campaignId: c.id, startDate: today, assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR },
      { now: new Date() },
    );
    console.log(`  + ${r.enrolled.length} enrolled in "${c.name}" (due today)`);
  }

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

/**
 * Dummy meetings, placed inside the current Sunday-to-Saturday week so the Home boxes and the
 * account timeline have something to show. One of each provider shape - see demo-meetings.ts.
 */
async function seedMeetings() {
  if (await prisma.meeting.count()) {
    console.log('  = dummy meetings exist, leaving them alone');
    return;
  }
  const settings = await getSettings();
  const today = todayIn('Europe/London');
  const weekStart = startOfWeekSunday(today);
  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true, aliases: true } });
  const mailbox = new Map<string, { id: string; name: string }>();
  for (const u of users) for (const key of [u.email, ...u.aliases]) if (key.includes('@')) mailbox.set(key.toLowerCase(), { id: u.id, name: u.name });

  for (const m of DEMO_MEETINGS) {
    // Keep past meetings inside this week; a scheduled one may sit in the next.
    const wanted = addDays(today, -m.daysAgo);
    const day = m.daysAgo >= 0 && wanted < weekStart ? weekStart : wanted;
    const occurredAt = new Date(`${day}T${String(m.hour).padStart(2, '0')}:00:00Z`);
    const link = parseMeetingLink(m.sourceUrl);
    const company = await prisma.companyCache.findUnique({ where: { id: m.companyId }, select: { id: true, name: true } });
    const emails = m.attendees.map((a) => a.email.toLowerCase());
    const people = await prisma.personCache.findMany({ where: { email: { in: emails, mode: 'insensitive' } }, select: { id: true, email: true } });
    const personByEmail = new Map(people.map((p) => [p.email?.toLowerCase(), p.id]));
    const host = m.attendees.find((a) => a.host);
    const createdById = host ? mailbox.get(host.email.toLowerCase())?.id ?? null : null;

    const meeting = await prisma.meeting.create({
      data: {
        title: m.title,
        provider: link.provider,
        sourceUrl: m.sourceUrl,
        embedUrl: link.embedUrl,
        mediaUrl: link.mediaUrl,
        occurredAt,
        durationSec: m.durationMin * 60,
        companyId: company?.id ?? null,
        companyName: company?.name ?? null,
        notes: m.notes ?? null,
        transcript: m.transcript ?? null,
        transcriptFormat: m.transcript ? detectTranscriptFormat(m.transcript) : null,
        createdById,
        attendees: {
          create: m.attendees.map((a) => ({
            name: a.name,
            email: a.email.toLowerCase(),
            personId: personByEmail.get(a.email.toLowerCase()) ?? null,
            userId: mailbox.get(a.email.toLowerCase())?.id ?? null,
            external: isExternalEmail(a.email, settings.rules.internalDomains),
            host: Boolean(a.host),
          })),
        },
      },
    });
    await logAudit({ entityType: 'meeting', entityId: meeting.id, action: 'created', actor: SYSTEM_ACTOR, details: { title: meeting.title, provider: meeting.provider } });
  }
  console.log(`  + ${DEMO_MEETINGS.length} dummy meetings (${DEMO_MEETINGS.filter((m) => m.transcript).length} with transcripts, no analysis - no model connected)`);
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
