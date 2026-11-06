import type { ConfirmOptions } from '@/components/confirm-dialog';
import type { LeaverWork } from '@/lib/outreach/ownership';

/**
 * What the remaining confirms say (cold outreach PLAN 4.0, "Confirms name every effect"): a short
 * question naming what it is about, then each thing that happens. These were browser-style sentences
 * on ActionButton; the cold contact's own confirms live in lib/outreach/confirm-words.ts. Pure: pages
 * and components build them where they render.
 */

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const CRM_TASKS = 'Steps mirrored as tasks in the CRM are closed there too.';

export function stopCampaignConfirm(c: { name?: string | null; restartable?: boolean } = {}): ConfirmOptions {
  return {
    title: `Stop ${c.name ?? 'this campaign'}?`,
    effects: ['Everyone still in it leaves it, marked "Campaign stopped".', `Every open step is cancelled. ${CRM_TASKS}`, c.restartable ? 'It cannot be resumed; you can restart it from the beginning later.' : 'It cannot be resumed.'],
    confirmLabel: 'Stop campaign',
    tone: 'danger',
  };
}

export function exitEnrollmentConfirm(c: { name?: string | null; campaign?: string | null } = {}): ConfirmOptions {
  const who = c.name ?? 'this person';
  return {
    title: `Take ${who} out of ${c.campaign ?? 'this campaign'}?`,
    effects: [`${c.name ?? 'Their'}${c.name ? '\'s' : ''} open steps in it are cancelled. ${CRM_TASKS}`, 'They show as "Removed" in this campaign and get nothing more from it.', 'Their other campaigns and next steps stay as they are.'],
    confirmLabel: 'Exit',
    tone: 'danger',
  };
}

export function deleteMeetingConfirm(m: { title?: string | null; inCrm: boolean }): ConfirmOptions {
  return {
    title: `Delete ${m.title ? `"${m.title}"` : 'this meeting'}?`,
    effects: ['The meeting and its transcript are deleted from Cadence. It cannot be undone.', ...(m.inCrm ? ['Its record in the CRM is deleted too.'] : []), 'Later meetings with the same prospects are numbered again.'],
    confirmLabel: 'Delete meeting',
    tone: 'danger',
  };
}

export function fullRefreshConfirm(): ConfirmOptions {
  return {
    title: 'Pull every person and company from the CRM?',
    effects: ['Cadence reads every person and company again and updates its copy. Nothing in the CRM changes.', 'It can take a while on a large workspace.'],
    confirmLabel: 'Full refresh',
  };
}

export function removePodConfirm(name: string): ConfirmOptions {
  return {
    title: `Remove ${name}?`,
    effects: ['It leaves the pod lists, and no campaign can start in it.', 'Its history and reports stay, and you can restore it here.'],
    confirmLabel: 'Remove pod',
    tone: 'danger',
  };
}

export function blockAccountConfirm(name: string): ConfirmOptions {
  return {
    title: `Block ${name}?`,
    effects: ['It leaves Accounts, People, search and enrichment for everyone.', 'Any sequence its people are in ends.'],
    confirmLabel: 'Block',
    tone: 'danger',
  };
}

export function unblockAccountConfirm(name: string): ConfirmOptions {
  return {
    title: `Put ${name} back in Cadence?`,
    effects: ['It shows again in Accounts, People, search and enrichment.', 'Sequences that ended when it was blocked stay ended.'],
    confirmLabel: 'Unblock',
  };
}

/** What a leaver holds, as Settings > Team counts it (outreach/ownership.ts leaverWork). */
export type LeaverHoldings = Pick<LeaverWork, 'contacts' | 'coldNextSteps' | 'crmNextActions' | 'meetings' | 'enrollments' | 'forms' | 'callerNumber'>;

/**
 * Settings > Team > Remove access (PLAN 8.8, N089): everything the leaver holds, each with where it
 * goes. `needsTaker` is true when any of it needs someone to take it over; their calling number only
 * does when it is moved rather than let go, which the dialog asks.
 */
export function removeAccessConfirm(name: string, w: LeaverHoldings | null): ConfirmOptions & { needsTaker: boolean } {
  const next = (w?.coldNextSteps ?? 0) + (w?.crmNextActions ?? 0);
  const effects = [
    `${name} is signed out and can no longer sign in. Their history stays.`,
    ...(w?.contacts ? [`${n(w.contacts, 'cold contact')} go to whoever takes over, with their campaigns and next steps. A contact in a pod that person is not in waits for the pod's leaders under "Needs a new owner".`] : []),
    ...(next ? [`${n(next, 'open next step')}${w!.meetings ? ` (${n(w!.meetings, 'meeting')})` : ''} go to them.${w!.crmNextActions ? ' The CRM ones are updated in the CRM too.' : ''}`] : []),
    ...(w?.enrollments ? [`${n(w.enrollments, 'live campaign enrollment')} and their pending steps go to them.`] : []),
    ...(w?.forms ? [`${n(w.forms, 'call form')} waiting go to them to fill in; the calls stay ${name}'s.`] : []),
    ...(w?.callerNumber ? [`Their calling number, ${w.callerNumber}, is let go or moved to them, as you choose below.`] : []),
    ...(!w || (!w.contacts && !next && !w.enrollments && !w.forms && !w.callerNumber) ? [`${name} holds no open work.`] : []),
  ];
  return {
    title: `Remove access for ${name}?`,
    effects,
    confirmLabel: 'Remove access',
    tone: 'danger',
    needsTaker: Boolean(w && (w.contacts || next || w.enrollments || w.forms)),
  };
}
