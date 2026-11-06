import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { SessionUser } from '../auth/current-user';
import { isAdmin, isBizOps, isPodLeader } from '../auth/rbac';
import { todayIn } from '../dates';
import { dueCounts, COLD_TASKS_HREF } from '../tasks-query';
import { pendingFormCount } from '../calls/form';
import { COLD_CONTACT_BASE, type ContactState } from '../subject';
import { coldCues, type ColdCue } from './cues';

/*
 * The rep's path (PLAN 4, "The rep's path"): Claim, Call it or add it to a campaign, Fill the form,
 * Set the next step, Move to CRM. The step strip shows it on the section's pages and on the contact
 * page, each step with a count for the reader and a link to where that work is.
 */

export type PathStepKey = 'claim' | 'work' | 'form' | 'next' | 'move';
export type PathStep = { key: PathStepKey; label: string; count: number; words: string; href: string };
export type RepPath = { steps: PathStep[]; /** The step the reader is most behind on (highlighted), or null when nothing waits. */ behind: PathStepKey | null };

/** Whose contacts the strip counts: a rep's own; a leader's pods; an admin's everyone. */
export function pathScope(user: SessionUser): Prisma.SandboxContactWhereInput {
  if (isAdmin(user) || isBizOps(user)) return {};
  if (isPodLeader(user) && user.role !== 'SENIOR_FO') return { podId: { in: user.podIds } };
  return { ownerId: user.id };
}

/** The views each step opens: the contacts list's quick views, Tasks for the work itself. */
export const PATH_HREFS: Record<PathStepKey, string> = {
  claim: `${COLD_CONTACT_BASE}?view=unclaimed`,
  work: COLD_TASKS_HREF,
  form: `${COLD_CONTACT_BASE}?view=form_due`,
  next: `${COLD_CONTACT_BASE}?view=no_next_step`,
  move: `${COLD_CONTACT_BASE}?view=ready`,
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The strip for the reader: one read of the contacts they work and a few counts. */
export async function repPath(user: SessionUser): Promise<RepPath> {
  const scope = pathScope(user);
  const today = todayIn(user.timezone);
  // A rep claims from the unclaimed contacts of their pods; a leader sees the same pool.
  const claimWhere: Prisma.SandboxContactWhereInput = { status: 'ACTIVE', crmMatchPersonId: null, crmAutoPersonId: null, OR: [{ ownerId: null }, { owner: { active: false } }], ...(isAdmin(user) || isBizOps(user) ? {} : { podId: { in: user.podIds } }) };
  const [toClaim, due, forms, mine] = await Promise.all([
    prisma.sandboxContact.count({ where: claimWhere }),
    dueCounts(user.id, 'cold', today),
    pendingFormCount(user.id),
    // AND, not a spread: a rep's scope is `ownerId`, which the owned-contacts filter must not overwrite.
    prisma.sandboxContact.findMany({ where: { AND: [scope, { status: 'ACTIVE', ownerId: { not: null }, owner: { active: true } }] }, select: { id: true }, take: 2000 }),
  ]);
  const cues = await coldCues(mine.map((c) => c.id), { today });
  const count = (s: ContactState) => [...cues.values()].filter((c) => c.state === s).length;
  return pathFrom({ claim: toClaim, work: due.today + due.overdue, form: forms, next: count('no_next_step'), move: count('ready_to_move') });
}

export function pathFrom(n: Record<PathStepKey, number>): RepPath {
  const steps: PathStep[] = [
    { key: 'claim', label: 'Claim', count: n.claim, words: plural(n.claim, 'to claim', 'to claim'), href: PATH_HREFS.claim },
    { key: 'work', label: 'Call or add to a campaign', count: n.work, words: plural(n.work, 'step due', 'steps due'), href: PATH_HREFS.work },
    { key: 'form', label: 'Fill the form', count: n.form, words: plural(n.form, 'form due', 'forms due'), href: PATH_HREFS.form },
    { key: 'next', label: 'Set the next step', count: n.next, words: plural(n.next, 'with no next step', 'with no next step'), href: PATH_HREFS.next },
    { key: 'move', label: 'Move to CRM', count: n.move, words: plural(n.move, 'ready to move', 'ready to move'), href: PATH_HREFS.move },
  ];
  // A form waiting blocks every call, so it is always the step to catch up on first; otherwise the
  // step with the most waiting, the earlier one on a tie.
  const behind = n.form > 0 ? 'form' : steps.reduce<PathStep | null>((best, s) => (s.count > (best?.count ?? 0) ? s : best), null)?.key ?? null;
  return { steps, behind };
}

/** Where one contact is on the path, for the contact page's strip. Null once it has left the path. */
export function contactPathStep(cue: Pick<ColdCue, 'state' | 'formDue' | 'worked'>): PathStepKey | null {
  if (cue.formDue) return 'form';
  switch (cue.state) {
    case 'unclaimed': return 'claim';
    case 'no_next_step': return cue.worked ? 'next' : 'work';
    case 'in_campaign': case 'next_step_set': return 'work';
    case 'ready_to_move': case 'moving': return 'move';
    default: return null;
  }
}
