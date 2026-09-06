import { describe, expect, it } from 'vitest';
import { actionTypesFor, classifyMessage, classifyNoteTitle, resolveNoteActor, type UserLike } from '@/lib/engine/matching';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { MOCK_MESSAGES } from '@/lib/twenty/fixtures';

const m = DEFAULT_SETTINGS.matching;

const users: UserLike[] = [
  { id: 'u-alisa', name: 'Alisa Marsh', email: 'alisa@cadence.local', twentyMemberId: 'wm-alisa', aliases: ['tw_alisa'] },
  { id: 'u-leigh', name: 'Leigh Turner', email: 'leigh@cadence.local', twentyMemberId: 'wm-leigh', aliases: [] },
  { id: 'u-ria', name: 'Ria Patel', email: 'ria@cadence.local', twentyMemberId: 'wm-ria', aliases: [] },
];

describe('note title matching', () => {
  it('recognises the three Twenty formats and captures the actor', () => {
    expect(classifyNoteTitle('[Email] Outbound email: Intro to Acme Logistics', m)).toEqual({ kind: 'outbound_email', actorHandle: null, dateText: null });
    expect(classifyNoteTitle('[CALL] Outbound Call by tw_alisa', m)).toEqual({ kind: 'outbound_call', actorHandle: 'tw_alisa', dateText: null });
    expect(classifyNoteTitle('Call Notes [31-Aug-2026]', m)).toEqual({ kind: 'call_notes', actorHandle: null, dateText: '31-Aug-2026' });
    expect(classifyNoteTitle('  [call] outbound call BY TW_LEIGH ', m).kind).toBe('outbound_call');
  });

  it('never treats Cadence notes or unrelated notes as evidence', () => {
    expect(classifyNoteTitle('[Cadence] Email 2 sent by Alisa', m).kind).toBe('cadence');
    expect(classifyNoteTitle('Meeting prep: Northwind Traders', m).kind).toBe('other');
    expect(classifyNoteTitle('', m).kind).toBe('other');
  });

  it('honours custom patterns and invalid ones fail closed', () => {
    const custom = { ...m, outboundEmailTitle: '^Sent:\\s+(?<actor>\\w+)', outboundCallTitle: '(' };
    expect(classifyNoteTitle('Sent: leigh follow up', custom)).toMatchObject({ kind: 'outbound_email', actorHandle: 'leigh' });
    expect(classifyNoteTitle('[CALL] Outbound Call by tw_alisa', custom).kind).toBe('other');
  });

  it('maps kinds to completable action types', () => {
    expect(actionTypesFor('outbound_email', m)).toEqual(['EMAIL']);
    expect(actionTypesFor('outbound_call', m)).toEqual(['CALL']);
    expect(actionTypesFor('call_notes', m)).toEqual(['CALL']);
    expect(actionTypesFor('call_notes', { ...m, callNotesCompleteCall: false })).toEqual([]);
    expect(actionTypesFor('other', m)).toEqual([]);
  });
});

describe('note actor resolution', () => {
  it('prefers the creating workspace member, then the title handle, then the name', () => {
    expect(resolveNoteActor({ createdByMemberId: 'wm-leigh', createdByName: 'Someone' }, 'tw_alisa', users)?.id).toBe('u-leigh');
    expect(resolveNoteActor({ createdByMemberId: null, createdByName: null }, 'tw_alisa', users)?.id).toBe('u-alisa');
    expect(resolveNoteActor({ createdByMemberId: null, createdByName: null }, 'TW_LEIGH', users)?.id).toBe('u-leigh'); // tw_<firstname>
    expect(resolveNoteActor({ createdByMemberId: null, createdByName: null }, 'ria', users)?.id).toBe('u-ria'); // email local part
    expect(resolveNoteActor({ createdByMemberId: null, createdByName: 'Ria Patel' }, null, users)?.id).toBe('u-ria');
    expect(resolveNoteActor({ createdByMemberId: 'wm-unknown', createdByName: 'Nobody' }, 'tw_nobody', users)).toBeNull();
  });
});

describe('message direction', () => {
  it('detects outbound from a user and inbound from a person', () => {
    const outbound = classifyMessage(MOCK_MESSAGES[0], users);
    expect(outbound.direction).toBe('outbound');
    if (outbound.direction === 'outbound') {
      expect(outbound.actor.id).toBe('u-alisa');
      expect(outbound.recipientPersonIds).toEqual(['person-01']);
    }
    const inbound = classifyMessage(MOCK_MESSAGES[1], users);
    expect(inbound.direction).toBe('inbound');
    if (inbound.direction === 'inbound') {
      expect(inbound.fromPersonId).toBe('person-05');
      expect(inbound.recipientUsers.map((u) => u.id)).toEqual(['u-alisa']);
    }
  });

  it('matches users by email handle when the participant is not linked to a member, and includes cc recipients', () => {
    const msg = { ...MOCK_MESSAGES[2], participants: MOCK_MESSAGES[2].participants.map((p) => (p.role === 'from' ? { ...p, workspaceMemberId: null, handle: 'leigh@cadence.local' } : p)) };
    const r = classifyMessage(msg, users);
    expect(r.direction).toBe('outbound');
    if (r.direction === 'outbound') expect(r.recipientPersonIds.sort()).toEqual(['person-15', 'person-16']);
  });

  it('gives up on messages without a usable sender', () => {
    const r = classifyMessage({ ...MOCK_MESSAGES[0], participants: [] }, users);
    expect(r.direction).toBe('unknown');
  });
});
