import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { ensurePod, refreshPersonCache, syncPodsFromTwenty, upsertPersonCache } from '@/lib/person-cache';
import { MockTwentyClient } from '@/lib/twenty/mock-client';
import { DEMO_PEOPLE } from '@/lib/twenty/demo-fixtures';
import { resetDb } from './helpers/db';

describe('pods follow Twenty', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('a person with an unknown podOwner creates the pod, flagged as discovered', async () => {
    expect(await prisma.pod.count()).toBe(0);
    await upsertPersonCache({ ...DEMO_PEOPLE[11], podOwner: 'ZOE' }); // Dummy Twelve with a brand new pod value
    const pod = await prisma.pod.findUnique({ where: { podOwnerValue: 'ZOE' } });
    expect(pod?.name).toBe('Zoe'); // ZOE is the Twenty value; the pod gets a readable name
    expect(pod?.discoveredAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'pod', entityId: pod!.id } });
    expect(audit?.action).toBe('discovered');
    // seeing the same value again does not create a second pod
    await upsertPersonCache({ ...DEMO_PEOPLE[10], podOwner: 'ZOE' });
    expect(await prisma.pod.count({ where: { podOwnerValue: 'ZOE' } })).toBe(1);
  });

  it('syncing from the Twenty options creates missing pods with their labels and renames on label change', async () => {
    const client = new MockTwentyClient();
    client.reset('demo'); // options: ALISA -> "Alisa's pod", ANDREW -> "Andrew's pod"
    const r = await syncPodsFromTwenty(client);
    expect(r.options).toBe(2);
    expect(r.created.sort()).toEqual(["Alisa's pod", "Andrew's pod"]);
    expect((await prisma.pod.findUnique({ where: { podOwnerValue: 'ALISA' } }))?.discoveredAt).toBeNull();

    // the admin renames the option label in Twenty; the value stays the key
    client.podOptions = client.podOptions.map((o) => (o.value === 'ALISA' ? { ...o, label: 'Team Alisa' } : o));
    const r2 = await syncPodsFromTwenty(client);
    expect(r2.renamed).toEqual(["Alisa's pod -> Team Alisa"]);
    expect((await prisma.pod.findUnique({ where: { podOwnerValue: 'ALISA' } }))?.name).toBe('Team Alisa');
    expect(await prisma.pod.count()).toBe(3); // ZOE, ALISA, ANDREW: nothing deleted

    // a discovered pod later appearing in the options picks up its label
    client.podOptions.push({ value: 'ZOE', label: "Zoe's pod" });
    await syncPodsFromTwenty(client);
    expect((await prisma.pod.findUnique({ where: { podOwnerValue: 'ZOE' } }))?.name).toBe("Zoe's pod");
  });

  it('a name clash falls back to "label (value)" and ensurePod is idempotent', async () => {
    await ensurePod('LEGACY', 'Team Alisa'); // label already used by the Alisa pod
    expect((await prisma.pod.findUnique({ where: { podOwnerValue: 'LEGACY' } }))?.name).toBe('Team Alisa (LEGACY)');
    const again = await ensurePod('LEGACY', null);
    expect(again?.name).toBe('Team Alisa (LEGACY)');
  });

  it('a full cache refresh syncs pods and people from the demo workspace', async () => {
    await resetDb();
    const client = new MockTwentyClient();
    client.reset('demo');
    const stats = await refreshPersonCache(client);
    expect(stats.people).toBe(DEMO_PEOPLE.length);
    const pods = await prisma.pod.findMany({ orderBy: { podOwnerValue: 'asc' } });
    expect(pods.map((p) => [p.podOwnerValue, p.name, Boolean(p.discoveredAt)])).toEqual([
      ['ALISA', "Alisa's pod", false],
      ['ANDREW', "Andrew's pod", false],
      ['KARSON', 'Karson', true], // Dummy Twelve's podOwner has no option in Twenty yet
    ]);
  });
});
