import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { LoginForm } from '@/components/login-form';
import { DemoLogin } from '@/components/demo-login';
import { env } from '@/lib/env';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect('/home');
  const { next } = await searchParams;
  const demo = env().TWENTY_MODE === 'mock';

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas p-6">
      {/* Soft indigo wash behind the card. */}
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full bg-brand-100/60 blur-3xl" />
      <div className="relative w-full max-w-[26rem]">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-600 text-[19px] font-bold text-white shadow-surface">C</span>
          <div>
            <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-ink-900">Cadence</h1>
            <p className="text-[12.5px] text-ink-500">The daily work surface beside Twenty CRM</p>
          </div>
        </div>
        <div className="surface p-6">
          <h2 className="mb-4 text-[15px] font-semibold text-ink-900">Sign in</h2>
          <LoginForm next={next} />
          {demo ? <DemoLogin /> : null}
        </div>
        <p className="mt-4 text-center text-[11.5px] text-ink-400">Humans do every touch. Cadence never sends email or automates LinkedIn.</p>
      </div>
    </main>
  );
}
