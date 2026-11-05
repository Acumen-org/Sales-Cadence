import type { ConfirmOptions } from '@/components/confirm-dialog';

/**
 * What the confirms for Opt out, Remove and Erase say (cold outreach PLAN 4.0): the person by name and
 * every effect, then a reason. One place, so the contact page, the contacts table and the form's Stop
 * group word an opt-out the same way. Pure: pages build them on the server and hand them down.
 */

export type ContactEffects = {
  name: string;
  /** Running campaigns, by name: each one ends. */
  campaigns?: string[];
  /** The open next step, as it reads: "Call on Thu 5 Nov". */
  nextStep?: string | null;
  /** Pushed from Bellwether: Bellwether shows them as Do not contact. */
  fromBellwether?: boolean;
  /** Moved to the CRM: the CRM person is marked Do not contact and their Next Action cleared (D6). */
  inCrm?: boolean;
};

const ends = (campaigns: string[] = []) => (campaigns.length ? [`${campaigns.length === 1 ? campaigns[0] : `${campaigns.length} campaigns (${campaigns.join(', ')})`} ${campaigns.length === 1 ? 'ends' : 'end'}.`] : []);
const cancels = (nextStep?: string | null) => (nextStep ? [`The next step (${nextStep}) is cancelled.`] : []);

export function optOutConfirm(c: ContactEffects): ConfirmOptions {
  return {
    title: `Opt ${c.name} out?`,
    effects: [
      `Cadence never calls, emails or messages ${c.name} again.`,
      ...ends(c.campaigns),
      ...cancels(c.nextStep),
      ...(c.inCrm ? ['The CRM marks them Do not contact and clears their Next Action.'] : []),
      ...(c.fromBellwether ? ['Bellwether shows them as Do not contact.'] : []),
    ],
    confirmLabel: 'Opt out',
    tone: 'danger',
    reason: { label: 'Why', required: true, placeholder: 'Asked by email not to be contacted' },
  };
}

export function removeConfirm(c: ContactEffects | number): ConfirmOptions {
  if (typeof c === 'number') {
    return {
      title: `Remove ${c} ${c === 1 ? 'contact' : 'contacts'} from Cold outreach?`,
      effects: ['Their details are cleared from Cadence.', 'Their campaigns end and their next steps are cancelled.', 'Bellwether may send them again later.'],
      confirmLabel: 'Remove',
      tone: 'danger',
      reason: { label: 'Why', required: true, placeholder: 'Not a fit for us' },
    };
  }
  return {
    title: `Remove ${c.name} from Cold outreach?`,
    effects: [`${c.name}'s details are cleared from Cadence.`, ...ends(c.campaigns), ...cancels(c.nextStep), ...(c.fromBellwether ? ['Bellwether may send them again later.'] : [])],
    confirmLabel: 'Remove',
    tone: 'danger',
    reason: { label: 'Why', required: true, placeholder: 'Not a fit for us' },
  };
}

export function eraseConfirm(c: ContactEffects): ConfirmOptions {
  return {
    title: `Erase ${c.name}?`,
    effects: [
      `Every piece of ${c.name}'s data in Cadence is deleted. It cannot be undone.`,
      'They stay on the suppression list, so they are never contacted again.',
      'Unlike Remove, Bellwether can never send them again.',
    ],
    confirmLabel: 'Erase',
    tone: 'danger',
    reason: { label: 'Why (optional)', placeholder: 'Erasure request of 3 Nov' },
  };
}
