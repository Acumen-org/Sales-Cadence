import type { MatchingSettings } from '../settings';
import type { TwentyMessage, TwentyNote } from '../twenty/types';

export type NoteKind = 'outbound_email' | 'outbound_call' | 'call_notes' | 'cadence' | 'other';

export type NoteClassification = {
  kind: NoteKind;
  /** Handle captured by the (?<actor>...) group, e.g. tw_alisa. */
  actorHandle: string | null;
  /** Date text captured by the (?<date>...) group of call notes. */
  dateText: string | null;
};

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/**
 * Classify a Twenty note by its title using the configurable patterns.
 * Cadence's own notes (prefix) are recognised first so they are never evidence.
 */
export function classifyNoteTitle(title: string, m: MatchingSettings): NoteClassification {
  const t = (title ?? '').trim();
  if (m.cadencePrefix && t.startsWith(m.cadencePrefix)) return { kind: 'cadence', actorHandle: null, dateText: null };
  const checks: Array<[NoteKind, string]> = [
    ['outbound_email', m.outboundEmailTitle],
    ['outbound_call', m.outboundCallTitle],
    ['call_notes', m.callNotesTitle],
  ];
  for (const [kind, pattern] of checks) {
    const re = compile(pattern);
    if (!re) continue;
    const match = re.exec(t);
    if (match) {
      return { kind, actorHandle: match.groups?.actor?.trim() || null, dateText: match.groups?.date?.trim() || null };
    }
  }
  return { kind: 'other', actorHandle: null, dateText: null };
}

export type UserLike = { id: string; name: string; email: string; twentyMemberId: string | null; aliases: string[] };

/**
 * Who performed a note's action: the Twenty workspace member that created it, else the
 * handle in the title (user alias, tw_<firstname>, or email local part), else the creator name.
 */
export function resolveNoteActor<U extends UserLike>(note: Pick<TwentyNote, 'createdByMemberId' | 'createdByName'>, actorHandle: string | null, users: U[]): U | null {
  if (note.createdByMemberId) {
    const byMember = users.find((u) => u.twentyMemberId === note.createdByMemberId);
    if (byMember) return byMember;
  }
  if (actorHandle) {
    const h = actorHandle.toLowerCase();
    const byAlias = users.find(
      (u) =>
        u.aliases.some((a) => a.toLowerCase() === h) ||
        `tw_${u.name.split(/\s+/)[0]?.toLowerCase()}` === h ||
        u.email.toLowerCase().split('@')[0] === h ||
        u.email.toLowerCase() === h,
    );
    if (byAlias) return byAlias;
  }
  if (note.createdByName) {
    const n = note.createdByName.trim().toLowerCase();
    const byName = users.find((u) => u.name.trim().toLowerCase() === n);
    if (byName) return byName;
  }
  return null;
}

export type MessageDirection =
  | { direction: 'outbound'; actor: UserLike; recipientPersonIds: string[]; fromHandle: string }
  | { direction: 'inbound'; fromPersonId: string | null; fromHandle: string; recipientUsers: UserLike[] }
  | { direction: 'unknown'; reason: string };

/**
 * Outbound = sent by one of our users (from participant is a workspace member, or its handle is
 * a user's email). Inbound = sent by a person (from participant has a personId). Everything else
 * is ignored: we never guess.
 */
export function classifyMessage(message: TwentyMessage, users: UserLike[]): MessageDirection {
  const from = message.participants.find((p) => p.role === 'from');
  if (!from) return { direction: 'unknown', reason: 'no from participant' };
  const handle = (from.handle ?? '').toLowerCase();
  const actor =
    (from.workspaceMemberId ? users.find((u) => u.twentyMemberId === from.workspaceMemberId) : undefined) ??
    users.find((u) => u.email.toLowerCase() === handle && handle !== '');
  if (actor) {
    const recipientPersonIds = [...new Set(message.participants.filter((p) => p.role !== 'from' && p.personId).map((p) => p.personId!))];
    return { direction: 'outbound', actor, recipientPersonIds, fromHandle: from.handle };
  }
  if (from.personId || handle) {
    const recipientUsers = message.participants
      .filter((p) => p.role !== 'from')
      .map((p) => (p.workspaceMemberId ? users.find((u) => u.twentyMemberId === p.workspaceMemberId) : users.find((u) => u.email.toLowerCase() === (p.handle ?? '').toLowerCase())))
      .filter((u): u is UserLike => Boolean(u));
    return { direction: 'inbound', fromPersonId: from.personId, fromHandle: from.handle, recipientUsers };
  }
  return { direction: 'unknown', reason: 'from participant is neither a user nor a person' };
}

/** Task action types that a given kind of evidence can complete. */
export function actionTypesFor(kind: NoteKind, m: MatchingSettings): Array<'EMAIL' | 'CALL'> {
  if (kind === 'outbound_email') return ['EMAIL'];
  if (kind === 'outbound_call') return ['CALL'];
  if (kind === 'call_notes' && m.callNotesCompleteCall) return ['CALL'];
  return [];
}
