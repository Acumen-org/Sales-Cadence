import Link from 'next/link';
import type { AccountGroup } from '@/lib/enrichment-work';
import { Badge, IdentityCell } from '@/components/ui';

/**
 * The queue folded under the firm. Each row is one account: what the account itself lacks, how
 * many of its people have something missing, and which kinds of information are missing most.
 * "Export" sends the whole account's people to research in one file. Plain forms, no client code.
 */
export function EnrichmentByAccount({ groups }: { groups: AccountGroup[] }) {
  return (
    <table className="table w-full table-fixed">
      <colgroup>
        <col style={{ width: '26%' }} />
        <col style={{ width: '28%' }} />
        <col style={{ width: '10%' }} />
        <col style={{ width: '26%' }} />
        <col style={{ width: '10%' }} />
      </colgroup>
      <thead><tr><th>Account</th><th>Account needs</th><th>Contacts</th><th>Most missing</th><th><span className="sr-only">Export</span></th></tr></thead>
      <tbody>
        {groups.map((g) => {
          const people = g.records.filter((r) => r.entity === 'person').map((r) => r.id);
          const entity = people.length ? 'person' : 'company';
          const ids = people.length ? people : g.records.filter((r) => r.entity === 'company').map((r) => r.id);
          return (
            <tr key={g.companyId ?? 'none'}>
              <td>{g.href ? <IdentityCell name={g.name} sub={g.owner} href={g.href} shape="square" /> : <IdentityCell name={g.name} sub={g.owner} shape="square" />}</td>
              <td><div className="flex flex-wrap gap-1.5">{g.accountGaps.length ? g.accountGaps.map((gap) => <Badge key={gap.field} tone={gap.priority === 'critical' ? 'amber' : 'gray'}>{gap.label}</Badge>) : <span className="text-[12px] text-ink-400">Complete</span>}</div></td>
              <td className="tabular-nums text-ink-900">{g.contacts ? <>{g.contacts} <span className="text-[12px] text-ink-500">· {g.contactGaps} gaps</span></> : <span className="text-ink-400">0</span>}</td>
              <td className="text-[12.5px] text-ink-700">{g.fields.slice(0, 3).map((f) => <span key={f.field} className="mr-2 inline-flex items-center gap-1 whitespace-nowrap">{f.label} <span className="tabular-nums text-ink-500">{f.count}</span></span>)}</td>
              <td className="text-right">
                {ids.length ? (
                  <form method="post" action="/enrichment/export" className="inline">
                    <input type="hidden" name="entity" value={entity} />
                    <input type="hidden" name="ids" value={ids.join('\n')} />
                    <button type="submit" className="btn-secondary btn-sm">Export</button>
                  </form>
                ) : null}
                {g.companyId ? <Link href={`/enrichment?tab=contacts&account=${g.companyId}`} className="btn-ghost btn-sm ml-1">Contacts</Link> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
