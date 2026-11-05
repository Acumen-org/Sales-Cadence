/**
 * How an enrollment's state reads, in one place for pages, notes and the CRM history (B102). An
 * enrollment a move to the CRM ended reads "Moved to CRM" in green, and one an opt-out ended "Opted
 * out", never a red "Removed" or a raw code.
 */

export type EnrollmentTone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'sky';

export const ENROLLMENT_TONES: Record<string, EnrollmentTone> = {
  ACTIVE: 'blue',
  PAUSED: 'amber',
  REPLIED: 'green',
  MEETING: 'purple',
  COMPLETED: 'gray',
  EXITED: 'red',
};

/** Outreach-style wording for an enrollment's state. */
export function enrollmentStatusLabel(e: { status: string; exitReason?: string | null }): string {
  switch (e.status) {
    case 'ACTIVE':
      return 'Active';
    case 'PAUSED':
      return 'Paused';
    case 'REPLIED':
      return 'Finished (Replied)';
    case 'MEETING':
      return 'Meeting booked';
    case 'COMPLETED':
      return 'Finished (No reply)';
    case 'EXITED': {
      const r = e.exitReason ?? '';
      if (r === 'moved_to_crm') return 'Moved to CRM';
      if (r === 'bounced') return 'Bounced';
      if (r === 'opted_out') return 'Opted out';
      if (r === 'dnd') return 'Do not contact';
      if (r === 'not_interested') return 'Not interested';
      if (r === 'not_a_prospect') return 'Not a prospect';
      if (r === 'bad_data') return 'Bad data';
      if (r === 'removed') return 'Contact removed';
      if (r === 'person_deleted') return 'Deleted in the CRM';
      if (r.startsWith('campaign_')) return 'Campaign stopped';
      return 'Removed';
    }
    default:
      return e.status.charAt(0) + e.status.slice(1).toLowerCase();
  }
}

/** The badge colour: an exit is red only when something went wrong; a move to the CRM is good news. */
export function enrollmentTone(e: { status: string; exitReason?: string | null }): EnrollmentTone {
  if (e.status === 'EXITED') {
    if (e.exitReason === 'moved_to_crm') return 'green';
    if (e.exitReason === 'not_interested' || e.exitReason?.startsWith('campaign_')) return 'gray';
  }
  return ENROLLMENT_TONES[e.status] ?? 'gray';
}
