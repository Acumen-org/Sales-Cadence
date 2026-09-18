import { liveRead } from '@/lib/twenty/live-read';
import { RefreshWhenChanged } from './refresh-when-changed';

/**
 * Re-reads one record from Twenty after the page has painted from the cache. Rendered inside a
 * Suspense boundary at the bottom of a record page, so the page never waits for the CRM and never
 * shows its errors; when the record changed, the page refreshes itself once.
 */
export async function RecordSync({ kind, id }: { kind: 'person' | 'company'; id: string }) {
  const result = await liveRead(kind, id);
  return <RefreshWhenChanged changed={result.changed} />;
}
