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

export function campaignStatusLabel(status: string): string {
  return CAMPAIGN_STATUS_LABELS[status] ?? status;
}
