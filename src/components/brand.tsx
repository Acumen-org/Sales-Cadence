import clsx from 'clsx';

/** Three connected beats: the Cadence mark, drawn locally at every size. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={clsx('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#d5e9ad] text-brand-950', className)}>
      <svg width="25" height="25" viewBox="0 0 28 28" fill="none">
        <path d="M5 18V12a4 4 0 0 1 8 0v4a4 4 0 0 0 8 0V9" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
        <circle cx="5" cy="22" r="1.8" fill="currentColor" />
        <circle cx="21" cy="5" r="1.8" fill="currentColor" />
      </svg>
    </span>
  );
}
