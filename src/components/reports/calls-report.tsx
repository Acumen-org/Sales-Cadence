import type { ReactNode } from 'react';
import type { CallListRow, CallReport, CallTotals } from '@/lib/calls/analytics';
import { callStatusWords } from '@/lib/calls/analytics';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { Fact, ACTIVITY_TIP } from './report-document';
import { Figure, pct } from './charts';

/**
 * Reports > Calls (PLAN 6) for one audience, as a document: the page shows it with its controls and
 * paging, the export renders it unchanged with neither (B125). In All outreach the calls are CRM +
 * Cold + Not matched yet (B122). It names the period it compares with, as Outreach does (B195).
 */

const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const mins = (sec: number) => (sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`);

/** The figures each side has, in the CRM / Cold / not matched yet table. */
const MEASURES: { key: keyof CallTotals; label: string; show: (v: number | null) => string }[] = [
  { key: 'dials', label: 'Calls out', show: (v) => fmt(v ?? 0) },
  { key: 'connects', label: 'Connects', show: (v) => fmt(v ?? 0) },
  { key: 'connectRate', label: 'Connect rate', show: (v) => pct(v ?? 0) },
  { key: 'inbound', label: 'Calls in', show: (v) => fmt(v ?? 0) },
  { key: 'conversations', label: 'Conversations', show: (v) => fmt(v ?? 0) },
  { key: 'talkSec', label: 'Talk time', show: (v) => mins(v ?? 0) },
  { key: 'meetings', label: 'Meetings booked', show: (v) => fmt(v ?? 0) },
  { key: 'avgRating', label: 'Average rating', show: (v) => (v == null ? '-' : String(v)) },
  { key: 'costUsd', label: 'Cost', show: (v) => `$${(v ?? 0).toFixed(2)}` },
];

/** S4's form flags in words (B029 and the long voicemail rule). */
const FLAG_WORDS: Record<string, string> = { called_opted_out: 'Called someone who opted out', long_voicemail: 'Voicemail over 2 minutes', no_conversation: 'No conversation' };

export type CallsDocumentProps = {
  data: CallReport;
  timezone: string;
  /** The period the figures are compared with, named as on Outreach (B195). */
  compared: { from: string; to: string } | null;
  /** Links to calls, contacts and the next page: the page has them, the exported file does not. */
  links?: { call: (id: string) => string; page: (patch: { page?: number; upage?: number }) => string } | null;
  /** The page's controls on an unmatched call (a rep to give it to, a contact to attach): client parts the export never renders. */
  unmatchedControls?: ((c: CallListRow) => { rep: ReactNode; contact: ReactNode }) | null;
};

function Pager({ page, pages, total, shown, href }: { page: number; pages: number; total: number; shown: number; href: ((n: number) => string) | null }) {
  if (total <= shown && page === 1) return null;
  return (
    <div className="rp-pager">
      <span>Showing {fmt(shown)} of {fmt(total)}</span>
      {href ? <span>{page > 1 ? <a href={href(page - 1)}>Previous</a> : null}{page < pages ? <a href={href(page + 1)}>Next</a> : null}</span> : null}
    </div>
  );
}

function Contact({ c, link }: { c: CallListRow; link: boolean }) {
  if (!c.subject) return <>{(c.direction === 'OUTBOUND' ? c.toNumber : c.fromNumber) ?? '-'}</>;
  const name = `${c.subject.firstName} ${c.subject.lastName}`.trim() || 'Unnamed';
  return (
    <>
      {link ? <a href={c.subject.href}>{name}</a> : name}
      {c.audience === 'SANDBOX' ? <span className="rp-badge">Cold</span> : null}
      {c.subject.companyName ? <div className="rp-small">{c.subject.companyName}</div> : null}
    </>
  );
}

export function CallsDocument({ data, timezone, compared, links, unmatchedControls }: CallsDocumentProps) {
  const t = data.totals;
  const b = data.previous;
  const all = data.audience === 'all';
  const parts = (key: keyof CallTotals) => (all ? [`${fmt(data.split.crm[key] as number)} CRM`, `${fmt(data.split.cold[key] as number)} Cold`, ...((data.split.unmatched[key] as number) ? [`${fmt(data.split.unmatched[key] as number)} not matched yet`] : [])].join(' · ') : null);
  // B195: a period with no calls before says so, never "0% before".
  const noneBefore = b !== null && b.dials === 0 && b.inbound === 0;
  return (
    <div className="rp">
      <div className="rp-meta"><span>{compared ? <>Compared with {formatLocalDate(compared.from, 'short')} → {formatLocalDate(compared.to, 'short')}{noneBefore ? ': no calls then' : ''}</> : null}</span></div>
      <div className="rp-facts">
        <Fact label="Calls out" tip={ACTIVITY_TIP} value={t.dials} previous={noneBefore ? null : b?.dials ?? null} parts={parts('dials')} />
        <Fact label="Connects" tip={`${ACTIVITY_TIP}. Calls out that the person answered; calls in are not connects.`} value={t.connects} previous={noneBefore ? null : b?.connects ?? null} parts={parts('connects')} />
        <Fact label="Connect rate" tip="Connects out of calls out: the same calls" value={t.connectRate} shown={pct(t.connectRate)} previous={noneBefore || !b?.dials ? null : b.connectRate} rate />
        <Fact label="Talk time" tip="Talk on calls that connected" value={t.talkSec} shown={mins(t.talkSec)} previous={null} note={t.connects ? <span>{mins(t.avgTalkPerConnect)} a connect</span> : null} />
        <Fact label="Forms waiting now" tip="Post-call forms not filled in yet, whatever the period" value={t.formsOutstanding} previous={null} warn note={t.medianMinutesToForm == null ? null : <span>median {t.medianMinutesToForm} min to a form</span>} />
        <Fact label="Calls to people who opted out" tip="Calls whose form says the person had opted out (B029)" value={t.calledOptedOut} previous={null} warn note={t.longVoicemails ? <span>{plural(t.longVoicemails, 'voicemail')} over 2 minutes</span> : null} />
      </div>

      {all ? (
        <Figure title="CRM, Cold outreach and not matched yet">
          <div className="rp-scroll"><table className="rp-table">
            <thead><tr><th>Measure</th><th className="rp-r">CRM</th><th className="rp-r">Cold outreach</th><th className="rp-r">Not matched yet</th><th className="rp-r">All outreach</th></tr></thead>
            <tbody>{MEASURES.map((m) => <tr key={m.key}><td className="rp-name">{m.label}</td>{(['crm', 'cold', 'unmatched', 'all'] as const).map((a) => <td key={a} className="rp-r">{m.show(data.split[a][m.key] as number | null)}</td>)}</tr>)}</tbody>
          </table></div>
        </Figure>
      ) : null}

      <div className="rp-row">
        <Figure title="By rep">
          {data.byRep.length ? (
            <div className="rp-scroll"><table className="rp-table">
              <thead><tr><th>Rep</th><th className="rp-r">Calls out</th><th className="rp-r">Connects</th><th className="rp-r">Rate</th><th className="rp-r">Meetings booked</th><th className="rp-r">Forms waiting now</th></tr></thead>
              <tbody>{data.byRep.map((r) => <tr key={r.userId}><td className="rp-name">{r.name}</td><td className="rp-r">{fmt(r.dials)}</td><td className="rp-r">{fmt(r.connects)}</td><td className="rp-r">{pct(r.connectRate)}</td><td className="rp-r">{fmt(r.meetings)}</td><td className="rp-r">{fmt(r.formsOutstanding)}{r.oldestFormDue ? <div className="rp-small">oldest {formatInstant(r.oldestFormDue, timezone)}</div> : null}</td></tr>)}</tbody>
            </table></div>
          ) : <p className="rp-empty">No calls in this period</p>}
        </Figure>
        <Figure title="Outcomes and best hours">
          <table className="rp-table"><tbody>
            {data.byOutcome.map((o) => <tr key={o.key}><td className="rp-name">{o.label}</td><td className="rp-r">{fmt(o.count)}</td></tr>)}
            {!data.byOutcome.length ? <tr><td className="rp-muted">No forms yet</td></tr> : null}
            {data.bestHours.map((h) => <tr key={h.slot}><td className="rp-name">{h.slot}:00</td><td className="rp-r">{pct(h.rate)} of {fmt(h.dials)}</td></tr>)}
            {!data.bestHours.length ? <tr><td className="rp-muted">Not enough calls out yet for best hours</td></tr> : null}
          </tbody></table>
        </Figure>
      </div>

      <Figure title="Calls" aside={plural(data.callsTotal, 'call')}>
        {data.calls.length ? (
          <div className="rp-scroll"><table className="rp-table">
            <thead><tr><th>When</th><th>Rep</th><th>Who</th><th>Direction</th><th>Result</th><th className="rp-r">Rating</th><th className="rp-r">Talk</th></tr></thead>
            <tbody>{data.calls.map((c) => (
              <tr key={c.id}>
                <td>{links ? <a href={links.call(c.id)}>{formatInstant(c.startedAt ?? c.createdAt, timezone)}</a> : formatInstant(c.startedAt ?? c.createdAt, timezone)}</td>
                <td>{c.user?.name ?? 'No rep yet'}</td>
                <td><Contact c={c} link={Boolean(links)} /></td>
                <td>{c.direction === 'OUTBOUND' ? 'Out' : 'In'}</td>
                <td>{c.form ? data.outcomes.find((o) => o.key === c.form!.outcome)?.label ?? 'Other' : callStatusWords(c)}{c.form?.flags.filter((f) => FLAG_WORDS[f]).map((f) => <span key={f} className="rp-flag">{FLAG_WORDS[f]}</span>)}</td>
                <td className="rp-r">{c.form?.rating ?? '-'}</td>
                <td className="rp-r">{c.talkSec ? mins(c.talkSec) : '-'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="rp-empty">No calls in this period</p>}
        <Pager page={data.page} pages={data.pages} total={data.callsTotal} shown={data.calls.length} href={links ? (n) => links.page({ page: n }) : null} />
      </Figure>

      <Figure title="Not matched yet" aside={plural(data.unmatchedTotal, 'call')}>
        {data.unmatched.length ? (
          <div className="rp-scroll"><table className="rp-table">
            <thead><tr><th>When</th><th>From</th><th>To</th><th>Rep</th><th>Who</th></tr></thead>
            <tbody>{data.unmatched.map((c) => {
              const controls = unmatchedControls?.(c) ?? null;
              return (
                <tr key={c.id}>
                  <td>{formatInstant(c.startedAt ?? c.createdAt, timezone)}</td>
                  <td className="rp-num">{c.fromNumber ?? '-'}</td>
                  <td className="rp-num">{c.toNumber ?? '-'}</td>
                  {/* B196: a call nobody is matched to shows in every filter, and says so. */}
                  <td>{c.user?.name ?? controls?.rep ?? <span className="rp-muted">No rep yet: shown in every filter</span>}</td>
                  <td>{c.subject ? <>{`${c.subject.firstName} ${c.subject.lastName}`.trim()}<div className="rp-small">Contact found, rep missing</div></> : controls?.contact ?? <span className="rp-muted">Nobody found for this number</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        ) : <p className="rp-empty">Every call is matched</p>}
        <Pager page={data.unmatchedPage} pages={data.unmatchedPages} total={data.unmatchedTotal} shown={data.unmatched.length} href={links ? (n) => links.page({ upage: n }) : null} />
      </Figure>
    </div>
  );
}
