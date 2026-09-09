import Link from 'next/link';
import { IconSearch } from '@/components/icons';
import { EmptyState } from '@/components/ui';

export default function RecordNotFound() {
  return <div className="px-6 py-8"><div className="surface"><EmptyState icon={<IconSearch size={22} />} title="We couldn’t find that record" hint="It may have been removed, or you may not have access to it." action={<Link href="/home" className="btn-primary">Back to your workspace</Link>} /></div></div>;
}
