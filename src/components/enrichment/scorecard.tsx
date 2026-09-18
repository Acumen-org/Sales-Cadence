import type { Scorecard, ScorecardGroup } from '@/lib/enrichment-work';
import { formatLocalDate } from '@/lib/dates';
import { GREEN_RAMP } from '@/components/reports/charts';

/**
 * How complete each field is, for everyone, each pod and each FO. One hue, light to dark, carries
 * the percentage; the number is always printed in ink, and the change since the snapshot about a
 * week ago sits under it, so nothing is colour-alone. Server-rendered, no client code.
 */
const INK = '#1f2a26';
/** The light half of the ramp only, so a board of complete fields reads calm and the number stays in ink. */
const shade = (pct: number) => GREEN_RAMP[Math.min(2, Math.floor((pct / 100) * 2.999))];
const pctOf = (filled: number, total: number) => (total ? Math.round((filled / total) * 100) : 0);

function Section({ title, groups, since }: { title: string; groups: ScorecardGroup[]; since: string | null }) {
  const fields = groups[0]?.cells ?? [];
  if (!groups.length || !fields.length) return null;
  const kinds: { kind: ScorecardGroup['kind']; label: string }[] = [{ kind: 'all', label: '' }, { kind: 'pod', label: 'By pod' }, { kind: 'fo', label: 'By FO' }];
  return (
    <div>
      <div className="flex items-baseline justify-between px-5 pb-2 pt-4"><span className="text-[13px] font-medium text-ink-900">{title}</span>{since ? <span className="text-[12px] text-ink-500">change since {formatLocalDate(since)}</span> : null}</div>
      <div className="overflow-x-auto scroll-thin">
        <table className="table table-dense w-full">
          <thead><tr><th>Group</th><th className="text-right">Records</th>{fields.map((f) => <th key={f.field} className="text-center">{f.label}</th>)}</tr></thead>
          <tbody>
            {kinds.flatMap(({ kind, label }) => {
              const rows = groups.filter((g) => g.kind === kind);
              if (!rows.length) return [];
              return [
                label ? <tr key={`${kind}-head`}><td colSpan={2 + fields.length} className="!py-1.5 text-[11px] font-medium text-ink-500">{label}</td></tr> : null,
                ...rows.map((g) => (
                  <tr key={`${g.kind}-${g.id}`}>
                    <td className="text-[13px] text-ink-900">{g.name}</td>
                    <td className="text-right tabular-nums text-ink-700">{g.total.toLocaleString('en-US')}</td>
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
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EnrichmentScorecard({ scorecard }: { scorecard: Scorecard }) {
  return (
    <div className="divide-y divide-line">
      <Section title="Contacts" groups={scorecard.contacts} since={scorecard.since} />
      <Section title="Accounts" groups={scorecard.accounts} since={scorecard.since} />
    </div>
  );
}
