'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { blockAccountAction, searchAccountsToBlock, unblockAccountAction } from '@/lib/actions/blocked-accounts';
import { IconLock, IconSearch } from '@/components/icons';
import { Card, Empty, EmptyState } from '@/components/ui';

export type BlockedRow = { companyId: string; name: string; domain: string | null; reason: string | null; byName: string | null; at: string };

/** Admin-only: which accounts Cadence refuses to show or work, and the search that adds one. */
export function BlockedAccountsPanel({ rows }: { rows: BlockedRow[] }) {
  const router = useRouter();
  const [term, setTerm] = useState('');
  const [reason, setReason] = useState('');
  const [matches, setMatches] = useState<{ id: string; name: string; domain: string | null }[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      if (term.trim().length < 2) {
        setMatches([]);
        return;
      }
      try {
        const found = await searchAccountsToBlock(term);
        if (live) setMatches(found);
      } catch {
        if (live) { setMatches([]); setMessage({ ok: false, text: 'Could not search accounts. Please try again.' }); }
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [term]);

  const run = (action: (fd: FormData) => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, payload: Record<string, string>) => {
    const fd = new FormData();
    for (const [key, value] of Object.entries(payload)) fd.set(key, value);
    start(async () => {
      let result;
      try { result = await action(fd); }
      catch { setMessage({ ok: false, text: 'Could not update this account. Please try again.' }); return; }
      setMessage(result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error });
      if (result.ok) {
        setTerm('');
        setReason('');
        setMatches([]);
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-3">
      <Card title="Block an account">
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-xs">
              <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Find an account by name or domain" aria-label="Find an account to block" className="!pl-9" />
            </div>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason for blocking" className="!w-auto !min-w-[16rem]" />
          </div>
          {matches.length ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {matches.map((match) => (
                <li key={match.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-ink-900">{match.name}</div>
                    {match.domain ? <div className="truncate text-xs text-ink-500">{match.domain}</div> : null}
                  </div>
                  <button
                    type="button"
                    disabled={pending}
                    className="btn-secondary btn-sm !border-red-200 !text-red-700 hover:!bg-red-50"
                    onClick={() => {
                      if (!window.confirm(`Block ${match.name}? It leaves Accounts, People, search and enrichment for everyone, and any sequence its people are in ends.`)) return;
                      run(blockAccountAction, { companyId: match.id, reason });
                    }}
                  >
                    <IconLock size={13} /> Block
                  </button>
                </li>
              ))}
            </ul>
          ) : term.trim().length >= 2 && !pending ? (
            <p className="text-xs text-ink-500" role="status">No account matches that.</p>
          ) : null}
          {message ? <p role="status" className={`text-xs ${message.ok ? 'text-emerald-700' : 'text-red-700'}`}>{message.text}</p> : null}
        </div>
      </Card>

      <Card title={`Blocked accounts (${rows.length})`}>
        {!rows.length ? (
          <EmptyState icon={<IconLock size={20} />} title="No blocked accounts" />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Reason</th>
                  <th>Blocked by</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.companyId}>
                    <td>
                      <Link href={`/accounts/${row.companyId}`} className="text-[13px] font-medium text-ink-900 hover:text-brand-700 hover:underline">{row.name}</Link>
                      {row.domain ? <div className="text-xs text-ink-500">{row.domain}</div> : null}
                    </td>
                    <td className="text-[12.5px] text-ink-700">{row.reason || <Empty />}</td>
                    <td className="text-[12.5px] text-ink-700">{row.byName || <Empty />}</td>
                    <td className="whitespace-nowrap text-[12.5px] text-ink-500">{row.at}</td>
                    <td className="text-right">
                      <button
                        type="button"
                        disabled={pending}
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          if (!window.confirm(`Put ${row.name} back in Cadence?`)) return;
                          run(unblockAccountAction, { companyId: row.companyId });
                        }}
                      >
                        Unblock
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
