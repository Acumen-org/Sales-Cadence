/**
 * What happened to an inbound CRM event, in words (Settings > Activity log). The raw code stays on
 * the row as a tooltip for whoever reads the logs.
 */
const PER_PERSON: Record<string, string> = {
  completed: 'Closed the step',
  no_pending_task: 'No step open',
  same_touch: 'Already counted',
  before_step_opened: 'Before the step opened',
  stale_evidence: 'From before they joined',
  no_active_enrollment: 'Not in a campaign',
  touch_only: 'On the timeline',
  paused: 'Held while the campaign is paused',
};

const EXACT: Record<string, string> = {
  duplicate: 'Already received',
  person_cached: 'Contact updated',
  person_unchanged: 'Contact unchanged',
  person_deleted: 'Contact deleted in Twenty',
  person_deleted_exited: 'Contact deleted in Twenty; their outreach ended',
  dnd_exited: 'Do not contact; their outreach ended',
  company_cached: 'Account added',
  company_updated: 'Account updated',
  company_unchanged: 'Account unchanged',
  company_deleted: 'Account deleted in Twenty',
  ignored_cadence_note: 'Written by Cadence',
  ignored_note_other: 'Not an email or call note',
  ignored_note_no_person: 'Note on no contact',
  ignored_deleted: 'Deleted in Twenty',
  ignored_message_not_found: 'Email no longer in Twenty',
  ignored_no_message_id: 'Not an email',
  ignored_outbound_no_person: 'Email to no contact',
  ignored_inbound_unknown_sender: 'Email from an unknown sender',
  ignored_message_unknown_direction: 'Email with no sender',
  inbound_no_active_enrollment: 'Reply from someone not in a campaign',
  inbound_automatic_reply: 'Automatic reply',
  replied: 'Reply: their outreach finished',
  already_replied: 'Reply already recorded',
  ignored_not_cadence_task: 'Not a Cadence task',
  ignored_task_resolved: 'Task already closed',
  twenty_task_open: 'Task still open in Twenty',
  twenty_task_done_completed: 'Closed from Twenty',
  twenty_task_deleted_unlinked: 'Task deleted in Twenty',
  meeting_from_opportunity: 'Opportunity: meeting booked',
  already_meeting: 'Meeting already recorded',
  opportunity_no_active_enrollment: 'Opportunity for someone not in a campaign',
  ignored_opportunity_no_contact: 'Opportunity with no contact',
  ignored_opportunity_disabled: 'Opportunities do not book meetings',
  no_record_id: 'No record',
  calendar_created: 'Meeting added from the calendar',
  calendar_updated: 'Meeting updated from the calendar',
  calendar_linked: 'Matched to a meeting added by hand',
  calendar_removed: 'Removed: event cancelled',
  calendar_read_already: 'Read with the rest of the event',
  calendar_skipped: 'Not a meeting with a contact',
  ignored_event_not_found: 'Event deleted from the calendar',
  ignored_no_event_id: 'Not a calendar event',
};

/** One line for the row. Given the outcome per person (from ingestEvent), an email or note says what it did for each. */
export function describeEventResult(result: string | null | undefined, details?: unknown): string | null {
  if (!result) return null;
  if (result.startsWith('error: ')) return `Failed: ${result.slice(7)}`;
  if (EXACT[result]) return EXACT[result];
  if (result.startsWith('ignored_object_')) return 'Not used';
  if (/_completed$/.test(result)) return result.includes('call') ? 'Closed a call step' : 'Closed an email step';
  // note_unknown_actor: rows written before unnamed notes counted.
  if (/_touch$/.test(result) || result === 'note_unknown_actor') {
    const codes = Object.values((details ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v in PER_PERSON);
    const words = [...new Set(codes.map((c) => PER_PERSON[c]))];
    return words.length ? words.join(', ') : 'On the timeline';
  }
  if (result.startsWith('twenty_task_')) return 'Could not close from Twenty';
  return result.replace(/_/g, ' ');
}
