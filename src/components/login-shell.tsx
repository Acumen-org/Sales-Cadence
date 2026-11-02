import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand';

/** The sign-in pages' frame: the wordmark and headline on the left, the way in on the right. */
export function LoginShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh bg-[#fafbf8] lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden min-h-dvh flex-col overflow-hidden bg-[#1c352d] p-12 text-white lg:flex xl:p-16">
        <div className="relative z-10 flex items-center gap-3"><BrandMark /><span className="text-[26px] font-semibold tracking-[-0.06em]">cadence<span className="text-[#d5e9ad]">.</span></span></div>
        <div className="relative z-10 my-auto max-w-lg py-16">
          <h1 className="text-[52px] font-medium leading-[1.08] tracking-[-0.055em] xl:text-[64px]">Your outreach,<br /><span className="text-[#d5e9ad]">one touch at a time.</span></h1>
        </div>
        <div className="focus-art !-bottom-32 !-right-16 !top-auto !h-[500px] !w-[500px]" aria-hidden />
      </section>
      <section className="flex flex-col items-center justify-center px-6 py-10 sm:px-12">
        <div className="w-full max-w-[370px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden"><BrandMark /><span className="text-[24px] font-semibold tracking-[-0.06em]">cadence.</span></div>
          <h2 className="text-[32px] font-semibold tracking-[-0.045em] text-ink-900">{title}</h2>
          {children}
        </div>
      </section>
    </main>
  );
}
