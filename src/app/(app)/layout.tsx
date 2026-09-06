import { requireUser } from '@/lib/auth/current-user';
import { Sidebar } from '@/components/sidebar';
import { env } from '@/lib/env';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const e = env();
  return (
    <div className="flex h-full min-h-screen">
      <Sidebar user={user} mode={e.TWENTY_MODE} dryRun={e.CADENCE_DRY_RUN} />
      <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
    </div>
  );
}
