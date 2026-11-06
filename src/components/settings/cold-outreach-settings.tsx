import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { optionLabel } from '@/lib/twenty/labels';
import { crmCheckWords } from '@/lib/sandbox/crm-check';
import type { ColdOutreachSettingsData } from '@/lib/sandbox/cold-settings';
import { COLD_FROM_BELLWETHER_HREF } from '@/lib/subject';
import { Badge, Card, Count, KeyValue, Notice } from '@/components/ui';
import { CleanupNowButton, ColdOutreachRulesForm, CrmCheckNowButton, SuppressionForm } from '@/components/settings/sandbox-settings';

/*
 * Settings > Cold outreach (PLAN 4.7, as the owner amended it on 5 Nov). Admins change the rules and
 * run the CRM check and the cleanup now; anyone else reads the same page, told who can change it
 * (B215). Retention is read only: it is always on and needs nobody (no switch, no Run now).
 */

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** A message as a sentence: an error from elsewhere may come without its full stop. */
const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
const line = (badge: ReactNode, words: ReactNode) => <span className="flex flex-wrap items-center gap-2">{badge}<span className="text-[12.5px] font-normal text-ink-600">{words}</span></span>;

export function ColdOutreachSettings({ data, canEdit, timezone }: { data: ColdOutreachSettingsData; canEdit: boolean; timezone: string }) {
  const { sandbox: s, bellwether: bw, crmCheck, retention: r, cleanup, suppressions } = data;
  const label = (key: keyof NonNullable<ColdOutreachSettingsData['choices']>['fields'], value: string) => data.choices?.fields[key].options.find((o) => o.value === value)?.label ?? optionLabel(value);
  const ready = [s.requireFirm && 'a firm', s.requireEmailOrPhone && 'an email, or a direct or mobile phone', s.requireOwnerLogin && 'an owner with a CRM login', s.requirePod && 'a pod'].filter(Boolean) as string[];
  return <div className="space-y-3">
    {canEdit ? null : <Notice>Read only. Only {data.admins.length ? `an admin (${data.admins.join(', ')})` : 'an admin'} can change Cold outreach settings, run the checks or see the suppression list. Ask them for a change.</Notice>}

    <Card title="Bellwether" actions={canEdit ? <Link href={COLD_FROM_BELLWETHER_HREF} className="btn-ghost btn-sm">Every push</Link> : null}>
      <div className="p-4"><KeyValue items={[
        { k: 'Connection', v: bw.keySet ? <Badge tone="green">Key set</Badge> : line(<Badge tone="amber">No key</Badge>, 'BELLWETHER_API_KEY is not set on the server, so every push is refused.') },
        ...(bw.previousKey ? [{ k: 'Previous key', v: 'Still accepted, during the rotation' }] : []),
        { k: 'Pushes', v: bw.enabled ? <Badge tone="green">Accepted</Badge> : line(<Badge tone="amber">Refused</Badge>, '"Bellwether may send contacts to Cold outreach" is off below.') },
        { k: 'Last push', v: bw.lastPush ? `${formatInstant(bw.lastPush.at, timezone)} · ${bw.lastPush.by}` : 'None yet' },
        { k: 'Last 7 days', v: <span className="tabular-nums">{n(bw.week.pushes, 'push', 'pushes')} · {n(bw.week.contacts, 'contact')} added</span> },
        { k: 'Cut off', v: bw.week.cutOff ? line(<Badge tone="amber">{bw.week.cutOff}</Badge>, `in the last 7 days: marked failed, and Bellwether's retry runs them again.${bw.failed ? ` ${n(bw.failed, 'push', 'pushes')} not sent again yet.` : ''}`) : 'None in the last 7 days' },
        ...(bw.stuck ? [{ k: 'Stuck now', v: line(<Badge tone="red">{bw.stuck}</Badge>, 'still being processed after 10 minutes; they are marked failed within 5 more.') }] : []),
        { k: 'Cadence errors', v: bw.week.internalErrors ? line(<Badge tone="amber">{n(bw.week.internalErrors, 'contact')}</Badge>, 'in the last 7 days Cadence failed on, finishing the rest of their push. Bellwether can send them again.') : 'None in the last 7 days' },
      ]} /></div>
    </Card>

    <Card title="Rules">
      {canEdit && data.choices ? <>
        {data.valueIssues.length ? <div className="space-y-1.5 px-4 pt-4">{data.valueIssues.map((t) => <Notice key={t} tone="warn">{t}</Notice>)}</div> : null}
        <ColdOutreachRulesForm s={s} choices={data.choices} />
      </> : <div className="p-4"><KeyValue items={[
        { k: 'From Bellwether', v: s.enabled ? 'Bellwether may send contacts' : 'Bellwether may not send contacts' },
        { k: 'Ready to move', v: ready.length ? `Needs ${ready.join(', ')}` : 'Needs names only' },
        { k: 'Lead source', v: `${label('leadSource', s.leadSource)} (else ${label('leadSource', s.leadSourceFallback)})` },
        { k: 'Contact type', v: s.contactType.map((v) => label('contactType', v)).join(', ') || 'None' },
        { k: 'List category', v: label('listCategory', s.listCategory) },
        { k: 'Pipeline stage', v: label('pipelineStage', s.pipelineStage) },
        { k: 'Per move', v: n(s.moveBatchLimit, 'contact') },
        { k: 'Undo window', v: `${n(s.undoDays, 'day')}. Applies to new moves only; existing moves keep their deadline.` },
      ]} /></div>}
    </Card>

    <Card title="Nightly CRM check" actions={canEdit ? <CrmCheckNowButton /> : null}>
      <p className="border-b border-line px-4 py-3 text-[13px] text-ink-600">Each night Cadence looks for every active contact in the CRM again. A contact someone has added to the CRM since it arrived stops its outreach and waits for Move to CRM, which adds its history to that person.</p>
      <div className="p-4"><KeyValue items={[
        { k: 'Last run', v: crmCheck.last ? `${formatInstant(crmCheck.last.at, timezone)} · ${crmCheck.last.by === 'nightly' ? 'nightly' : `run by ${crmCheck.last.by}`}` : 'Not run yet' },
        { k: 'Result', v: !crmCheck.last ? null : crmCheck.last.error || !crmCheck.last.stats ? line(<Badge tone="red">Failed</Badge>, `${sentence(crmCheck.last.error ?? 'No result was recorded')} It runs again tonight.`) : crmCheckWords(crmCheck.last.stats) },
        { k: 'In the CRM now', v: `${n(crmCheck.inCrmNow, 'contact')} waiting for Move to CRM` },
        { k: 'Nightly jobs', v: crmCheck.nightly ? (crmCheck.nightly.late ? line(<Badge tone="amber">Late</Badge>, `last ran ${formatInstant(crmCheck.nightly.at, timezone)}. The worker runs them each night; check that it is running.`) : `Last ran ${formatInstant(crmCheck.nightly.at, timezone)}`) : line(<Badge tone="amber">Not run yet</Badge>, 'The worker runs them each night, after the reconcile hour.') },
      ]} /></div>
    </Card>

    <Card title="Retention">
      <p className="border-b border-line px-4 py-3 text-[13px] text-ink-600">
        Always on, and nobody needs to do anything. Each night Cadence removes the contacts nobody has worked for a long time: their details are cleared and Bellwether reads them as removed. It never removes a contact with an open next step, a running campaign, a call form waiting or a move in flight, and every action on a contact counts as activity. Each night it also records here what it would remove in the next {r.horizonDays} days.
      </p>
      <div className="p-4"><KeyValue items={[
        { k: 'Rule', v: `${n(r.inactiveDays, 'day')} without activity, or ${n(r.unworkedDays, 'day')} after arriving when nobody worked it` },
        { k: 'Worked out', v: r.at ? formatInstant(r.at, timezone) : 'Not yet: the first nightly run records it' },
        { k: `Next ${r.horizonDays} days`, v: r.at ? (r.total ? `${n(r.total, 'contact')} would be removed` : 'Nobody would be removed') : null },
        ...(r.next ? [{ k: 'First removals', v: `${n(r.next.count, 'contact')} on ${formatLocalDate(r.next.on, 'long')}` }] : []),
        ...(r.atNextRun ? [{ k: 'Tonight', v: line(<Badge tone="amber">{r.atNextRun}</Badge>, `${r.atNextRun === 1 ? 'contact' : 'contacts'} will be removed tonight, unless someone works ${r.atNextRun === 1 ? 'it' : 'them'} first.`) }] : []),
        { k: 'Owners warned', v: `Owners are told ${n(r.warnDays, 'day')} ahead${r.warned ? `: ${n(r.warned, 'contact')} due within that time` : ''}.` },
        { k: 'Kept, also in the CRM', v: r.at ? `${n(r.moveToCrmNeeded, 'contact')}: Move to CRM needed` : null },
        { k: 'Removed last night', v: r.at ? n(r.removedLastRun, 'contact') : null },
      ]} /></div>
    </Card>

    <Card title="CRM cleanup" actions={canEdit ? <CleanupNowButton /> : null}>
      <div className="p-4"><KeyValue items={[
        { k: 'Status', v: s.cleanupAutoCreated ? <Badge tone="green">On, every 5 minutes</Badge> : <Badge>Off</Badge> },
        { k: 'Removed', v: <span className="tabular-nums">{n(cleanup.total, 'person', 'people')} · {cleanup.week} in the last 7 days</span> },
        { k: 'Kept and flagged', v: <span className="tabular-nums">{n(cleanup.kept, 'contact')}</span> },
      ]} /></div>
      <p className="px-4 pb-4 text-[12px] text-ink-500">People the CRM made from an email or a calendar invite for a cold contact, that nobody has edited, noted, given a task or put in a campaign. They go to the CRM&apos;s trash and can be restored there.</p>
    </Card>

    <Card title="Suppression list" actions={<Count value={suppressions.total} />}>
      {canEdit ? <>
        <SuppressionForm />
        {suppressions.rows.length ? <table className="w-full text-[13px]">
          <thead><tr className="border-y border-line text-left text-ink-500"><th className="px-4 py-2 font-normal">Value</th><th className="px-4 py-2 font-normal">Kind</th><th className="px-4 py-2 font-normal">Why</th><th className="px-4 py-2 font-normal">From</th><th className="px-4 py-2 font-normal">Added</th></tr></thead>
          <tbody className="divide-y divide-line">{suppressions.rows.map((row) => <tr key={row.id}>
            <td className="px-4 py-2 tabular-nums">{row.label}</td><td className="px-4 py-2 text-ink-600">{row.kind}</td><td className="px-4 py-2 text-ink-600">{row.reason}</td><td className="px-4 py-2 text-ink-600">{row.source ?? '-'}</td><td className="px-4 py-2 tabular-nums text-ink-500">{formatInstant(row.at, timezone)}</td>
          </tr>)}</tbody>
        </table> : <p className="px-4 pb-4 text-[13px] text-ink-500">Nobody is on the list yet.</p>}
        {suppressions.total > suppressions.rows.length ? <p className="px-4 py-3 text-[12px] text-ink-500">Showing the latest {suppressions.rows.length} of {suppressions.total}.</p> : null}
      </> : <p className="p-4 text-[13px] text-ink-600">{n(suppressions.total, 'entry', 'entries')}. Nobody on it is ever contacted.</p>}
    </Card>
  </div>;
}
