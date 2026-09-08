'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { IconSearch } from '@/components/icons';

export function AccountsToolbar({ q, scope, mineCount, allCount }: { q: string; scope: 'all' | 'mine'; mineCount: number; allCount: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q);

  useEffect(() => {
    const t = setTimeout(() => {
      if (text === q) return;
      const next = new URLSearchParams(params.toString());
      if (text) next.set('q', text);
      else next.delete('q');
      router.push(`${pathname}?${next.toString()}`);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const withScope = (s: 'all' | 'mine') => {
    const next = new URLSearchParams(params.toString());
    if (s === 'mine') next.set('scope', 'mine');
    else next.delete('scope');
    return `${pathname}?${next.toString()}`;
  };

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search accounts" aria-label="Search accounts" className="!pl-9" />
      </div>
      <Link href={withScope('all')} className={scope === 'all' ? 'chip' : 'chip-muted'}>
        All <span className="ml-0.5 opacity-60">{allCount}</span>
      </Link>
      <Link href={withScope('mine')} className={scope === 'mine' ? 'chip' : 'chip-muted'}>
        Mine <span className="ml-0.5 opacity-60">{mineCount}</span>
      </Link>
    </div>
  );
}
