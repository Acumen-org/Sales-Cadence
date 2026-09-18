import type { EnrichmentQueueItem } from '@/lib/enrichment-work';

/** A queue item with every fact defaulted, so a test names only what it is about. */
export function queueItem(partial: Partial<EnrichmentQueueItem> & Pick<EnrichmentQueueItem, 'id' | 'label'>): EnrichmentQueueItem {
  return {
    company: null, companyId: null, entity: 'person', href: `/people/${partial.id}`, twentyUrl: null, owner: null, ownerMemberIds: [], podOwners: [],
    tier: null, contactType: [], productInterest: [], tags: [], inCampaign: false, syncedAt: new Date('2026-09-01T00:00:00Z'), gaps: [], hidden: [],
    ...partial,
  };
}
