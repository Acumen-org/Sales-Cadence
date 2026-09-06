import { describe, expect, it } from 'vitest';
import { MockTwentyClient } from '@/lib/twenty/mock-client';
import { MOCK_PEOPLE } from '@/lib/twenty/fixtures';
import { collectAll } from '@/lib/twenty/client';

describe('MockTwentyClient fixtures', () => {
  const client = new MockTwentyClient();

  it('has 3 pods, 6 members and 40 people', async () => {
    const people = await collectAll((after) => client.listPeople({ after, limit: 15 }));
    expect(people).toHaveLength(40);
    const pods = new Set(people.map((p) => p.podOwner));
    expect([...pods].sort()).toEqual(['Alisa', 'Andrew', 'Leigh']);
    expect(await client.listWorkspaceMembers()).toHaveLength(6);
    expect(people.filter((p) => p.dnd)).toHaveLength(3);
    expect(new Set(people.map((p) => p.id)).size).toBe(40);
    expect(new Set(people.map((p) => p.email)).size).toBe(40);
  });

  it('paginates deterministically', async () => {
    const first = await client.listPeople({ limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.hasNextPage).toBe(true);
    const second = await client.listPeople({ limit: 10, after: first.endCursor });
    expect(second.items[0].id).toBe(MOCK_PEOPLE[10].id);
  });

  it('contains notes in the exact Twenty title formats', async () => {
    const notes = (await client.listNotes()).items;
    const titles = notes.map((n) => n.title);
    expect(titles).toContain('[Email] Outbound email: Intro to Acme Logistics');
    expect(titles).toContain('[CALL] Outbound Call by tw_alisa');
    expect(titles).toContain('Call Notes [31-Aug-2026]');
  });

  it('filters activity by person and resolves views', async () => {
    const notes = await client.listNotes({ personId: 'person-01' });
    expect(notes.items.map((n) => n.id)).toEqual(['note-01']);
    const msgs = await client.listMessages({ personId: 'person-16' });
    expect(msgs.items.map((m) => m.id)).toEqual(['msg-03']);
    const { view, people } = await client.getViewPeople('view-pod-alisa');
    expect(view.name).toMatch(/Alisa/);
    expect(people.every((p) => p.podOwner === 'Alisa')).toBe(true);
    expect(people).toHaveLength(14);
  });

  it('records writes and applies them to state', async () => {
    const c = new MockTwentyClient();
    const { id } = await c.createTask({ title: 'Cadence: Email 1', personId: 'person-01', assigneeMemberId: 'wm-alisa' });
    expect((await c.getTask(id))?.status).toBe('TODO');
    await c.updateTask(id, { status: 'DONE' });
    expect((await c.getTask(id))?.status).toBe('DONE');
    const note = await c.createNote({ title: '[Cadence] Email 1 sent by Alisa', bodyMarkdown: 'x', personId: 'person-01' });
    expect((await c.listNotes({ personId: 'person-01' })).items.map((n) => n.id)).toContain(note.id);
    expect(c.writes.map((w) => w.op)).toEqual(['createTask', 'updateTask', 'createNote']);
    await c.deleteTask(id);
    expect(await c.getTask(id)).toBeNull();
  });

  it('can simulate failures and reset', async () => {
    const c = new MockTwentyClient();
    c.failNext = new Error('boom');
    await expect(c.listPeople()).rejects.toThrow('boom');
    await expect(c.listPeople()).resolves.toBeTruthy();
    c.updatePerson('person-01', { dnd: true });
    expect((await c.getPerson('person-01'))?.dnd).toBe(true);
    c.reset();
    expect((await c.getPerson('person-01'))?.dnd).toBe(false);
  });
});
