/** One vocabulary for campaign states, wherever one is shown. */
export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Needs approval',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Running',
  PAUSED: 'Paused',
  STOPPED: 'Stopped',
  COMPLETED: 'Completed',
};

/** Why the enrolment preview left somebody out, in the words shown wherever a preview is. */
export const ENROLL_CONFLICT_LABELS: Record<string, string> = {
  dnd: 'Do not contact',
  already_active: 'Already in a sequence',
  pod_mismatch: 'Belongs to another pod in Twenty',
  not_found: 'Not found in Twenty',
  deleted: 'Deleted in Twenty',
  duplicate: 'Duplicate id',
  no_fo: 'No eligible FO',
  internal: 'Internal team or organisation',
  invalid_start: 'Invalid start date',
  opted_out: 'Asked not to be contacted',
  bad_data: 'Contact details are not usable',
};

export function enrollConflictLabel(reason: string): string {
  return ENROLL_CONFLICT_LABELS[reason] ?? reason;
}

export function campaignStatusLabel(status: string): string {
  return CAMPAIGN_STATUS_LABELS[status] ?? status;
}
