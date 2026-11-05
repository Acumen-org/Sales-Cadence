import type { RulesSettings } from './settings';

/**
 * The one list of call outcomes (N055): Settings > Rules' own, then the ones the post-call form always
 * offers (plan section 10). Reports' answered count, the Tasks labels and Log call, the CRM note's
 * label and the form all read it, so an outcome never shows as a raw key or goes uncounted.
 */
export const EXTRA_CALL_OUTCOMES: RulesSettings['callDispositions'] = [
  { key: 'not_interested', label: 'Not interested', answered: true, badPhone: false },
  { key: 'meeting_booked', label: 'Meeting booked', answered: true, badPhone: false },
  { key: 'do_not_contact', label: 'Asked not to be contacted', answered: true, badPhone: false },
  // B025: the line was picked up but nobody spoke (a machine, a hang-up): allowed with a reason.
  { key: 'no_conversation', label: 'Line connected, no conversation', answered: false, badPhone: false },
];

/** "Asked not to be contacted": the person picked up, but it is never a reply (B091). */
export const OPT_OUT_OUTCOME = 'do_not_contact';

/** Settings > Rules' call outcomes, then the extras it does not already have. */
export function callOutcomes(rules: Pick<RulesSettings, 'callDispositions'>): RulesSettings['callDispositions'] {
  return [...rules.callDispositions, ...EXTRA_CALL_OUTCOMES.filter((x) => !rules.callDispositions.some((d) => d.key === x.key))];
}
