import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canEnrich } from '@/lib/enrichment';
import { EnrichmentImportForm } from '@/components/enrichment/import-form';
export default async function ImportEnrichmentPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const user = await requireUser();
  if (!canEnrich(user)) redirect('/enrichment');
  const sp = await searchParams;
  return <div className="space-y-4 px-6 pb-8 pt-2"><Link href="/enrichment" className="btn-ghost btn-sm">Back to data readiness</Link><EnrichmentImportForm initialEntity={sp.entity === 'company' ? 'company' : 'person'} /></div>;
}
