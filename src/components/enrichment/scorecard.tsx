import Link from 'next/link';
import type { Scorecard, ScorecardGroup } from '@/lib/enrichment-work';
import { formatLocalDate } from '@/lib/dates';
import { GREEN_RAMP } from '@/components/reports/charts';

/**
 * How complete each field is: for everyone, then by pod, then by FO, as three blocks under
 * People and again under Accounts. One hue, light to dark, carries the percentage; the number is
 * always printed in ink, and the change since the snapshot about a week ago sits under it. The
 * record count is a link into that group's queue - the People or Accounts tab with that pod or
 * FO already chosen. Server-rendered, no client code.
 */
const INK = '#1f2a26';
const shade = (pct: number) => (pct >= 100 ? GREEN_RAMP[2] : pct >= 90 ? GREEN_RAMP[1] : pct >= 70 ? GREEN_RAMP[0] : '#eef3ee');
const pctOf = (filled: number, total: number) => (total ? Math.round((filled / total) * 100) : 0);

type Props = { scorecard: Scorecard; /** Twenty member id -> Cadence user id, so an FO row links to that FO's queue. */ foUserByMember: Record<string, string> };

function groupHref(g: ScorecardGroup, tab: 'contacts' | 'accounts', foUserByMember: Record<string, string>): string | null {
  if (g.kind === 'all') return `/enrichment?tab=${tab}&records=all`;
  if (g.kind === 'pod') return `/enrichment?tab=${tab}&records=all&pod=${encodeURIComponent(g.id)}`;
  const userId = foUserByMember[g.id];
  return userId ? `/enrichment?tab=${tab}&records=all&fo=${encodeURIComponent(userId)}` : null;
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
                    return (
                      <td key={c.field} className="p-1 text-center">
                        <div className="rounded-md px-2 py-1.5 tabular-nums" style={{ background: g.total ? shade(pct) : '#e3e8e2', color: INK }} title={`${g.name} · ${c.label}: ${c.filled.toLocaleString('en-US')} of ${c.total.toLocaleString('en-US')}${before !== null ? ` · was ${before}%` : ''}`}>
                          <div className="text-[13px] text-ink-900">{g.total ? `${pct}%` : '–'}</div>
                          {diff !== null && g.total ? <div className={`text-[11px] ${diff > 0 ? 'text-emerald-800' : diff < 0 ? 'text-amber-800' : 'text-ink-600'}`}>{diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : 'same'}</div> : null}
                        </div>
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
      <Section title="People" groups={scorecard.contacts} tab="contacts" since={scorecard.since} foUserByMember={foUserByMember} />
      <Section title="Accounts" groups={scorecard.accounts} tab="accounts" since={scorecard.since} foUserByMember={foUserByMember} />
    </div>
  );
}
