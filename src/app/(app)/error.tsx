'use client';

import Link from 'next/link';
import { IconRefresh } from '@/components/icons';

export default function WorkspaceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="px-6 py-10"><div className="surface mx-auto max-w-lg p-10 text-center"><span className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><IconRefresh size={22} /></span><h2 className="text-xl font-semibold tracking-tight">This view couldn’t load.</h2><p className="mt-3 text-sm leading-relaxed text-ink-500">Try again in a moment, or return to your workspace.</p><div className="mt-6 flex justify-center gap-2"><button type="button" onClick={reset} className="btn-primary">Try again</button><Link href="/home" className="btn-secondary">Go home</Link></div></div></div>;
}
