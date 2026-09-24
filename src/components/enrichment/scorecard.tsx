import Link from 'next/link';
import type { Scorecard, ScorecardGroup } from '@/lib/enrichment-work';
import { formatLocalDate } from '@/lib/dates';

/**
 * How complete each field is: for everyone, then by pod, then by FO, as three blocks under
 * People and again under Accounts. A complete field is quiet grey; below 90% it is tinted amber, below
 * 70% red, and the cell opens that group's records missing the field. The change since the
 * snapshot about a week ago sits under the number. The
 * record count is a link into that group's queue - the People or Accounts tab with that pod or
 * FO already chosen. Server-rendered, no client code.
 */
// Complete fields go quiet; the eye goes to what is short, tinted by how short.
const band = (pct: number) => (pct >= 100 ? 'text-ink-500' : pct >= 90 ? 'text-ink-900' : pct >= 70 ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800');
const pctOf = (filled: number, total: number) => (total ? Math.round((filled / total) * 100) : 0);

type Props = { scorecard: Scorecard; /** Twenty member id -> Cadence user id, so an FO row links to that FO's queue. */ foUserByMember: Record<string, string> };

function groupHref(g: ScorecardGroup, tab: 'contacts' | 'accounts', foUserByMember: Record<string, string>): string | null {
  if (g.kind === 'all') return `/enrichment?tab=${tab}&records=all`;
  if (g.kind === 'pod') return `/enrichment?tab=${tab}&records=all&pod=${encodeURIComponent(g.id)}`;
  const userId = foUserByMember[g.id];
  return userId ? `/enrichment?tab=${tab}&records=all&fo=${encodeURIComponent(userId)}` : null;
}

/** The queue of this group's records missing this one field. */
function fieldHref(g: ScorecardGroup, tab: 'contacts' | 'accounts', field: string, foUserByMember: Record<string, string>): string | null {
  const base = `/enrichment?tab=${tab}&field=${encodeURIComponent(field)}`;
  if (g.kind === 'all') return base;
  if (g.kind === 'pod') return `${base}&pod=${encodeURIComponent(g.id)}`;
  const userId = foUserByMember[g.id];
  return userId ? `${base}&fo=${encodeURIComponent(userId)}` : null;
}

function Block({ title, groups, tab, foUserByMember }: { title: string; groups: ScorecardGroup[]; tab: 'contacts' | 'accounts'; foUserByMember: Record<string, string> }) {
  const fields = groups[0]?.cells ?? [];
  if (!groups.length || !fields.length) return null;
  return (
    <div className="border-t border-line">
      {title === 'Everyone' ? null : <div className="px-5 pb-2 pt-4 text-[12px] font-medium text-ink-500">{title}</div>}
      <div className="overflow-x-auto scroll-thin">
        <table className="table table-dense w-full table-fixed">
          <colgroup><col style={{ width: 200 }} /><col style={{ width: 96 }} />{fields.map((f) => <col key={f.field} />)}</colgroup>
          <thead><tr><th>{title === 'Everyone' ? '' : title === 'By pod' ? 'Pod' : 'FO'}</th><th className="text-right">Records</th>{fields.map((f) => <th key={f.field} className="text-center">{f.label}</th>)}</tr></thead>
          <tbody>
            {groups.map((g) => {
              const href = groupHref(g, tab, foUserByMember);
              return (
                <tr key={`${g.kind}-${g.id}`}>
                  <td className="text-[13px] text-ink-900">{g.name}</td>
                  <td className="text-right tabular-nums">{href ? <Link href={href} className="text-brand-700 hover:underline" title="Open this group's queue">{g.total.toLocaleString('en-US')}</Link> : <span className="text-ink-700">{g.total.toLocaleString('en-US')}</span>}</td>
                  {g.cells.map((c) => {
                    const pct = pctOf(c.filled, c.total);
                    const before = c.previous ? pctOf(c.previous.filled, c.previous.total) : null;
                    const diff = before === null ? null : pct - before;
                    const gapHref = g.total && pct < 100 ? fieldHref(g, tab, c.field, foUserByMember) : null;
                    const body = <>
                      <div className="text-[13px]">{g.total ? `${pct}%` : '–'}</div>
                      {diff !== null && g.total ? <div className={`text-[11px] ${diff > 0 ? 'text-emerald-800' : diff < 0 ? 'text-amber-800' : 'text-ink-500'}`}>{diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : 'same'}</div> : null}
                    </>;
                    const title = `${g.name} · ${c.label}: ${c.filled.toLocaleString('en-US')} of ${c.total.toLocaleString('en-US')}${before !== null ? ` · was ${before}%` : ''}${gapHref ? ' · open the records missing it' : ''}`;
                    return (
                      <td key={c.field} className="p-1 text-center">
                        {gapHref ? <Link href={gapHref} title={title} className={`block rounded-md px-2 py-1.5 tabular-nums hover:underline ${band(pct)}`}>{body}</Link> : <div title={title} className={`rounded-md px-2 py-1.5 tabular-nums ${g.total ? band(pct) : 'text-ink-300'}`}>{body}</div>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Section({ title, groups, tab, since, foUserByMember }: { title: string; groups: ScorecardGroup[]; tab: 'contacts' | 'accounts'; since: string | null; foUserByMember: Record<string, string> }) {
  if (!groups.length) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between px-5 pb-3 pt-5"><span className="text-[15px] font-medium text-ink-900">{title}</span>{since ? <span className="text-[12px] text-ink-500">change since {formatLocalDate(since)}</span> : null}</div>
      <Block title="Everyone" groups={groups.filter((g) => g.kind === 'all')} tab={tab} foUserByMember={foUserByMember} />
      <Block title="By pod" groups={groups.filter((g) => g.kind === 'pod')} tab={tab} foUserByMember={foUserByMember} />
      <Block title="By FO" groups={groups.filter((g) => g.kind === 'fo')} tab={tab} foUserByMember={foUserByMember} />
    </div>
  );
}

export function EnrichmentScorecard({ scorecard, foUserByMember }: Props) {
  return (
    <div className="divide-y-4 divide-canvas">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-4 text-[12px] text-ink-500"><span>Share of records with each field filled.</span><span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded bg-amber-50 ring-1 ring-amber-200" />under 90%</span><span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded bg-red-50 ring-1 ring-red-200" />under 70%</span><span>A cell under 100% opens the records missing that field.</span></p>
      <Section title="People" groups={scorecard.contacts} tab="contacts" since={scorecard.since} foUserByMember={foUserByMember} />
      <Section title="Accounts" groups={scorecard.accounts} tab="accounts" since={scorecard.since} foUserByMember={foUserByMember} />
    </div>
  );
}
