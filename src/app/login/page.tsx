import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { LoginForm } from '@/components/login-form';
import { DemoLogin } from '@/components/demo-login';
import { BrandMark } from '@/components/brand';
import { IconMail, IconPeople, IconPhone } from '@/components/icons';
import { env } from '@/lib/env';

/**
 * The way in.
 *
 * This is an internal tool for one team, so the left panel says what the app does - who to reach,
 * on which channel, and that a person performs every touch - instead of selling it. There were
 * four separate slogans here and a row of tick marks that had drifted away from the lines they
 * belonged to; both are gone.
 */
const WHAT_IT_DOES = [
  { label: 'Who to reach today', detail: 'From your pod, in Twenty', Icon: IconPeople },
  { label: 'What to say, ready to edit', detail: 'Email and LinkedIn drafts', Icon: IconMail },
  { label: 'What happened, recorded', detail: 'Calls, replies and meetings', Icon: IconPhone },
];

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
          <h1 className="text-[52px] font-medium leading-[1.08] tracking-[-0.055em] xl:text-[64px]">Your outreach,<br /><span className="text-[#d5e9ad]">one touch at a time.</span></h1>
          <div className="mt-12 max-w-sm space-y-0" aria-label="What Cadence does">
            {WHAT_IT_DOES.map(({ label, detail, Icon }, i) => (
              <div key={label} className="relative flex items-center gap-4 py-4">
                {i < WHAT_IT_DOES.length - 1 ? <span aria-hidden className="absolute left-[21px] top-[54px] h-8 w-px bg-white/10" /> : null}
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] text-[#d5e9ad]"><Icon size={19} /></span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-[#e6eee8]">{label}</span>
                  <span className="mt-1 block text-[11px] text-[#9fb9aa]">{detail}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="focus-art !-bottom-32 !-right-16 !top-auto !h-[500px] !w-[500px]" aria-hidden />
        <p className="relative z-10 text-[11px] text-[#9fb9aa]">Beside Twenty CRM. A person sends every message.</p>
      </section>
      <section className="flex flex-col items-center justify-center px-6 py-10 sm:px-12">
        <div className="w-full max-w-[370px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden"><BrandMark /><span className="text-[24px] font-semibold tracking-[-0.06em]">cadence.</span></div>
          <h2 className="text-[32px] font-semibold tracking-[-0.045em] text-ink-900">Sign in</h2>
          <p className="mb-8 mt-2 text-[13px] leading-relaxed text-ink-500">Use your work email.</p>
          <LoginForm next={next} />
          {demo ? <DemoLogin /> : null}
        </div>
      </section>
    </main>
  );
}
