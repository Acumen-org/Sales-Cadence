import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { getTwentyConnection, getTwentySchema } from '../src/lib/settings';
import { getTwentyClient } from '../src/lib/twenty';
import type { TwentySchema } from '../src/lib/twenty/twenty-schema';
import type { TwentyIntrospection, TwentyObjectInfo } from '../src/lib/twenty/types';

/**
 * `pnpm verify:schema`: introspect the Twenty workspace and report every object or field in
 * the effective mapping (twenty-schema.ts + Settings overrides) that is missing or renamed.
 * Exit code 1 when a required field is missing; optional fields only warn.
 */

type Check = { section: string; key: string; field: string; required: boolean };

const OPTIONAL = new Set([
  // Custom person fields. All of them are optional: a workspace missing one degrades to null
  // rather than failing, and verify:schema only warns, so a partial workspace still runs.
  'person.additionalNumber',
  'person.xLink',
  'person.createdBy',
  'person.assignedTo',
  'person.assignedToId',
  'person.podOwner',
  'person.rotationTracking',
  'person.rotationChangedAt',
  'person.dnd',
  'person.tags',
  'person.leadSource',
  'person.leadSourceNotes',
  'person.tier',
  'person.contactType',
  'person.listCategory',
  'person.previousCadence',
  'person.pipelineStageField',
  'person.productInterest',
  'person.primaryProduct',
  'person.onGoingCampaigns',
  'person.callingList',
  'person.dealSignalStrength',
  'person.nextAction',
  'person.nextActionDueDate',
  'person.nextStep',
  'person.nextActionDueDatePoc',
  'person.lastNote',
  'person.latestCallActivity',
  'person.lastEmailActivity',
  'person.meetingTime',
  'person.meetingLink',
  'person.salesCallRecordingLink',
  'person.bookingId',
  'person.city',
  'task.cadenceTaskId',
  'workspaceMember.timeZone',
  'message.text',
  'message.messageThreadId',
]);

function checksFor(schema: TwentySchema): Array<{ object: keyof TwentySchema['objects']; checks: Check[] }> {
  const sections: Array<[keyof TwentySchema['objects'], Record<string, string>]> = [
    ['person', schema.person],
    ['company', schema.company],
    ['note', schema.note],
    ['noteTarget', schema.noteTarget],
    ['task', schema.task],
    ['taskTarget', schema.taskTarget],
    ['message', schema.message],
    ['messageParticipant', schema.messageParticipant],
    ['opportunity', schema.opportunity],
    ['workspaceMember', schema.workspaceMember],
  ];
  return sections.map(([object, fields]) => ({
    object,
    checks: Object.entries(fields).map(([key, field]) => ({ section: object, key, field, required: !OPTIONAL.has(`${object}.${key}`) })),
  }));
}

function findObject(intro: TwentyIntrospection, singular: string, plural: string): TwentyObjectInfo | undefined {
  const s = singular.toLowerCase();
  const p = plural.toLowerCase();
  return intro.objects.find((o) => o.nameSingular.toLowerCase() === s || o.namePlural.toLowerCase() === p);
}

function suggest(field: string, available: string[]): string[] {
  const f = field.toLowerCase().replace(/id$/, '');
  return available.filter((a) => {
    const n = a.toLowerCase();
    return n !== field && (n.includes(f) || f.includes(n) || n.replace(/id$/, '') === f);
  });
}

async function main() {
  const conn = await getTwentyConnection();
  const schema = await getTwentySchema();
  console.log(`Twenty mode: ${conn.mode}${conn.baseUrl ? ` (${conn.baseUrl})` : ''}${conn.dryRun ? ' [dry run]' : ''}`);
  if (conn.mode === 'graphql' && (!conn.baseUrl || !conn.apiKey)) {
    console.error('TWENTY_API_URL / TWENTY_API_KEY are not set (env or Settings > Twenty).');
    process.exit(2);
  }
  const client = await getTwentyClient();
  console.log('Introspecting...');
  const intro = await client.introspect();
  console.log(`Source: ${intro.source}, ${intro.objects.length} objects\n`);

  let missingRequired = 0;
  let missingOptional = 0;

  for (const { object, checks } of checksFor(schema)) {
    const def = schema.objects[object];
    const found = findObject(intro, def.singular, def.plural);
    if (!found) {
      console.log(`✗ object ${def.singular} / ${def.plural}: NOT FOUND`);
      missingRequired += checks.filter((c) => c.required).length;
      continue;
    }
    const available = found.fields.map((f) => f.name);
    const problems: string[] = [];
    for (const c of checks) {
      if (available.includes(c.field)) continue;
      const hint = suggest(c.field, available);
      const line = `  ${c.required ? '✗' : '!'} ${c.section}.${c.key} -> "${c.field}" missing${hint.length ? ` (similar: ${hint.join(', ')})` : ''}${c.required ? '' : ' [optional]'}`;
      problems.push(line);
      if (c.required) missingRequired += 1;
      else missingOptional += 1;
    }
    console.log(`${problems.length ? '!' : '✓'} ${def.singular} (${found.namePlural}): ${checks.length - problems.length}/${checks.length} fields ok`);
    for (const p of problems) console.log(p);

    if (object === 'person') {
      const podOwner = found.fields.find((f) => f.name === schema.person.podOwner);
      if (podOwner?.options?.length) {
        console.log(`  podOwner options in Twenty: ${podOwner.options.join(', ')}`);
        const pods = await prisma.pod.findMany({ select: { name: true, podOwnerValue: true } });
        for (const pod of pods) {
          if (!podOwner.options.includes(pod.podOwnerValue)) console.log(`  ! pod "${pod.name}" uses podOwner value "${pod.podOwnerValue}" which is not one of the options above`);
        }
        const unpodded = podOwner.options.filter((o) => !pods.some((p) => p.podOwnerValue === o));
        if (unpodded.length) console.log(`  i options without a Cadence pod yet: ${unpodded.join(', ')} (create them in Settings > Users and pods)`);
      }
      // Every select we map: report the workspace's values against the ones we expect, because
      // a renamed option shows up as an empty filter rather than as an error.
      const selects: Array<[label: string, field: string, expected: readonly string[]]> = [
        ['dnd', schema.person.dnd, schema.personValues.dnd],
        ['tier', schema.person.tier, schema.personValues.tier],
        ['listCategory', schema.person.listCategory, schema.personValues.listCategory],
        ['contactType', schema.person.contactType, schema.personValues.contactType],
        ['pipelineStageField', schema.person.pipelineStageField, schema.personValues.pipelineStage],
        ['productInterest', schema.person.productInterest, schema.personValues.productInterest],
        ['nextStep', schema.person.nextStep, schema.personValues.nextStep],
        ['onGoingCampaigns', schema.person.onGoingCampaigns, schema.personValues.onGoingCampaigns],
      ];
      for (const [label, field, expected] of selects) {
        const f = found.fields.find((x) => x.name === field);
        if (!f?.options?.length) continue;
        const unknown = expected.filter((v) => !f.options!.includes(v));
        console.log(`  ${label}: ${f.options.join(', ')}${unknown.length ? `  ! mapping expects ${unknown.join(', ')}, which the workspace does not have` : ''}`);
      }
    }
    if (object === 'task') {
      const status = found.fields.find((f) => f.name === schema.task.status);
      if (status?.options?.length) {
        const want = Object.values(schema.taskStatus);
        const missing = want.filter((v) => !status.options!.includes(v));
        console.log(`  task.status options: ${status.options.join(', ')}${missing.length ? ` (mapping expects ${missing.join(', ')}: update taskStatus in Settings > Twenty)` : ''}`);
      }
    }
  }

  console.log('\nSmoke test: reading one person...');
  try {
    const page = await client.listPeople({ limit: 1 });
    const p = page.items[0];
    console.log(p ? `✓ ${p.firstName} ${p.lastName} (${p.email ?? 'no email'}) dnd=${p.dnd} podOwner=${p.podOwner ?? '-'}` : '✓ query ok, workspace has no people');
  } catch (err) {
    console.log(`✗ people query failed: ${err instanceof Error ? err.message : String(err)}`);
    missingRequired += 1;
  }

  console.log(`\n${missingRequired} required problem(s), ${missingOptional} optional field(s) missing.`);
  if (missingOptional) console.log('Optional fields fall back to null; matching and reports still work without them.');
  process.exitCode = missingRequired ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
