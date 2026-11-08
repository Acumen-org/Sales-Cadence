'use client';

import { Fragment, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createApiKeyAction, revokeApiKeyAction } from '@/lib/actions/api-keys';
import { Badge, Card, EmptyState } from '@/components/ui';
import { IconLock } from '@/components/icons';
import { useConfirm } from '@/components/confirm-dialog';
import { revokeApiKeyConfirm } from '@/lib/confirms';

export type ApiKeyRow = {
  id: string;
  name: string;
  scopes: string[];
  allowedIps: string[];
  state: 'live' | 'expired' | 'revoked';
  expires: string;
  createdBy: string;
  created: string;
  lastUsed: string;
  lastUsedIp: string | null;
  requests: { at: string; path: string; status: number; rows: number | null; ms: number }[];
};

const STATE_TONE = { live: 'green', expired: 'amber', revoked: 'gray' } as const;

/** Admin-only: read API keys for scripts and tools (CONTRACT.md). A new key is shown once. */
export function ApiKeysPanel({ rows, scopes, defaultDays, maxDays, appUrl }: { rows: ApiKeyRow[]; scopes: readonly { key: string; label: string; what: string }[]; defaultDays: number; maxDays: number; appUrl: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [never, setNever] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [ask, dialog] = useConfirm();

  const create = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    start(async () => {
      let result;
      try { result = await createApiKeyAction(fd); }
      catch { setMessage({ ok: false, text: 'Could not create the key. Please try again.' }); return; }
      if (!result.ok) { setMessage({ ok: false, text: result.error }); return; }
      setMessage({ ok: true, text: result.message ?? 'Key created.' });
      setNewKey((result.data as { key: string }).key);
      form.reset();
      setNever(false);
      router.refresh();
    });
  };

  const revoke = async (row: ApiKeyRow) => {
    if (!(await ask(revokeApiKeyConfirm(row.name)))) return;
    const fd = new FormData();
    fd.set('id', row.id);
    start(async () => {
      let result;
      try { result = await revokeApiKeyAction(fd); }
      catch { setMessage({ ok: false, text: 'Could not revoke the key. Please try again.' }); return; }
      setMessage(result.ok ? { ok: true, text: result.message ?? 'Revoked.' } : { ok: false, text: result.error });
      if (result.ok) router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      {dialog}
      <Card title="Create a read API key">
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); create(e.currentTarget); }}>
          <p className="text-xs text-ink-500">
            For a script or tool (Power BI, Excel, n8n, an agent) to read Cadence. Keys only read: nothing can be changed through them.
            Send it as <code>Authorization: Bearer &lt;key&gt;</code> to <code>{appUrl}/api/v1</code>, which lists what the key may read.
          </p>
          <label className="block">
            <span className="text-xs font-medium text-ink-700">Name</span>
            <input name="name" required maxLength={80} placeholder="e.g. Power BI weekly report" aria-label="Key name" />
          </label>
          <fieldset>
            <legend className="text-xs font-medium text-ink-700">What it may read</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {scopes.map((s) => (
                <label key={s.key} className="flex items-start gap-2 text-[13px]">
                  <input type="checkbox" name="scopes" value={s.key} className="mt-0.5 !w-auto" />
                  <span><span className="font-medium text-ink-900">{s.label}</span> <span className="text-ink-500">{s.what}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-xs font-medium text-ink-700">Expires after (days)</span>
              <input name="expiresInDays" type="number" min={1} max={maxDays} defaultValue={defaultDays} disabled={never} className="!w-28" aria-label="Expires after days" />
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name="neverExpires" checked={never} onChange={(e) => setNever(e.target.checked)} className="!w-auto" /> Never expires
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-ink-700">Only from these IPs (optional)</span>
            <input name="allowedIps" placeholder="e.g. 203.0.113.7, 10.0.0.0/8" aria-label="Allowed IP addresses" />
            <span className="text-xs text-ink-500">Leave empty for any address. Needs API_TRUSTED_PROXY_HOPS set on the server.</span>
          </label>
          <button type="submit" className="btn-primary btn-sm" disabled={pending}>Create key</button>
          {message ? <p role="status" className={`text-xs ${message.ok ? 'text-emerald-700' : 'text-red-700'}`}>{message.text}</p> : null}
          {newKey ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="text-xs font-medium text-amber-900">Copy this key now. It will not be shown again.</div>
              <div className="mt-2 flex items-center gap-2">
                <code className="block min-w-0 flex-1 break-all rounded bg-white px-2 py-1 text-[12px]" data-testid="new-api-key">{newKey}</code>
                <button type="button" className="btn-secondary btn-sm" onClick={() => navigator.clipboard?.writeText(newKey)}>Copy</button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => setNewKey(null)}>Done</button>
              </div>
            </div>
          ) : null}
        </form>
      </Card>

      <Card title={`Keys (${rows.length})`}>
        {!rows.length ? (
          <EmptyState icon={<IconLock size={20} />} title="No API keys yet" />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="table table-dense">
              <thead>
                <tr><th>Name</th><th>Reads</th><th>State</th><th>Expires</th><th>Last used</th><th>Created</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <td><div className="font-medium text-ink-900">{row.name}</div><div className="text-xs text-ink-500">cad_{row.id}_…{row.allowedIps.length ? ` · ${row.allowedIps.join(', ')}` : ''}</div></td>
                      <td className="text-xs">{row.scopes.join(', ')}</td>
                      <td><Badge tone={STATE_TONE[row.state]}>{row.state}</Badge></td>
                      <td className="text-xs">{row.expires}</td>
                      <td className="text-xs">{row.lastUsed}{row.lastUsedIp ? <div className="text-ink-500">{row.lastUsedIp}</div> : null}</td>
                      <td className="text-xs">{row.created}<div className="text-ink-500">{row.createdBy}</div></td>
                      <td className="whitespace-nowrap text-right">
                        <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(open === row.id ? null : row.id)} aria-expanded={open === row.id}>Requests</button>
                        {row.state === 'live' ? <button type="button" disabled={pending} className="btn-secondary btn-sm ml-1 !border-red-200 !text-red-700 hover:!bg-red-50" onClick={() => revoke(row)}>Revoke</button> : null}
                      </td>
                    </tr>
                    {open === row.id ? (
                      <tr>
                        <td colSpan={7} className="bg-[#f8faf9]">
                          {!row.requests.length ? <p className="text-xs text-ink-500">No requests in the last 90 days.</p> : (
                            <table className="table table-dense">
                              <thead><tr><th>When</th><th>Path</th><th>Status</th><th>Rows</th><th>ms</th></tr></thead>
                              <tbody>{row.requests.map((r, i) => <tr key={i}><td className="text-xs">{r.at}</td><td className="text-xs"><code>{r.path}</code></td><td className="text-xs">{r.status}</td><td className="text-xs">{r.rows ?? ''}</td><td className="text-xs">{r.ms}</td></tr>)}</tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
