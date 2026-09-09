import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { LoginForm } from '@/components/login-form';
import { DemoLogin } from '@/components/demo-login';
import { BrandMark } from '@/components/brand';
import { IconCheck, IconMail, IconPeople, IconPhone } from '@/components/icons';
import { env } from '@/lib/env';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect('/home');
  const { next } = await searchParams;
  const demo = env().TWENTY_MODE === 'mock';
  return (
    <main className="grid min-h-dvh bg-[#fafbf8] lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden min-h-dvh flex-col overflow-hidden bg-[#1c352d] p-12 text-white lg:flex xl:p-16">
        <div className="relative z-10 flex items-center gap-3"><BrandMark /><span className="text-[26px] font-semibold tracking-[-0.06em]">cadence<span className="text-[#d5e9ad]">.</span></span></div>
        <div className="relative z-10 my-auto max-w-lg py-16">
          <p className="mb-6 text-[10px] font-medium uppercase tracking-[0.2em] text-[#bcd199]">Built for meaningful connections</p>
          <h1 className="text-[60px] font-medium leading-[1.06] tracking-[-0.06em] xl:text-[76px]">Every touch.<br /><span className="text-[#d5e9ad]">A step forward.</span></h1>
          <p className="mt-7 max-w-sm text-[15px] leading-7 text-[#b9cec1]">Turn your team's outreach into lasting relationships. A thoughtful workspace for the people behind every conversation.</p>
          <div className="mt-12 max-w-sm space-y-0" aria-label="The Cadence workflow">
            {[
              { label: 'Find your next opportunity', detail: 'People & account intelligence', Icon: IconPeople },
              { label: 'Make every message personal', detail: 'Sequences that keep you in the flow', Icon: IconMail },
              { label: 'Move the conversation forward', detail: 'Calls, meetings & a shared history', Icon: IconPhone },
            ].map(({ label, detail, Icon }, i) => <div key={label} className="relative flex items-center gap-4 py-4">{i < 2 ? <span aria-hidden className="absolute left-[21px] top-[54px] h-8 w-px bg-white/10" /> : null}<span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] text-[#d5e9ad]"><Icon size={19} /></span><span><span className="block text-[13px] font-medium text-[#e6eee8]">{label}</span><span className="mt-1 block text-[11px] text-[#9fb9aa]">{detail}</span></span><IconCheck size={14} className="ml-auto text-[#90ad79]" /></div>)}
          </div>
        </div>
        <div className="focus-art !-bottom-32 !-right-16 !top-auto !h-[500px] !w-[500px]" aria-hidden />
        <p className="relative z-10 text-[11px] text-[#9fb9aa]">Your relationships. Your rhythm. Cadence.</p>
      </section>
      <section className="flex flex-col items-center justify-center px-6 py-10 sm:px-12">
        <div className="w-full max-w-[370px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden"><BrandMark /><span className="text-[24px] font-semibold tracking-[-0.06em]">cadence.</span></div>
          <p className="eyebrow mb-3">A good day starts here</p>
          <h2 className="text-[32px] font-semibold tracking-[-0.045em] text-ink-900">Welcome back.</h2>
          <p className="mb-8 mt-2 text-[13px] leading-relaxed text-ink-500">Sign in to your workspace and find your next move.</p>
          <LoginForm next={next} />
          {demo ? <DemoLogin /> : null}
          <p className="mt-8 text-[10px] leading-relaxed text-ink-500">Connected to Twenty CRM. Powered by your team.<br />You make every touch. Cadence keeps it all in rhythm.</p>
        </div>
      </section>
    </main>
  );
}
