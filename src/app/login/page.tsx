import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { LoginForm } from '@/components/login-form';
import { DemoLogin } from '@/components/demo-login';
import { env } from '@/lib/env';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect('/tasks');
  const { next } = await searchParams;
  const demo = env().TWENTY_MODE === 'mock';
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="card w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold text-white">C</div>
          <div>
            <h1 className="text-lg font-semibold">Cadence</h1>
            <p className="text-xs text-slate-500">Sign in to your outreach workspace</p>
          </div>
        </div>
        <LoginForm next={next} />
        {demo ? <DemoLogin /> : null}
      </div>
    </main>
  );
}
