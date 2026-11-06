import Link from 'next/link';
import type { ColdTaskBrief } from '@/lib/brief';
import { formatLocalDate } from '@/lib/dates';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { CallButton } from '@/components/calls/call-button';
import { ActionIcon } from '@/components/icons';
import { Avatar, Badge, enrollmentStatusLabel, enrollmentTone, KeyValue, RecordFields, Surface } from '@/components/ui';
import { Section, TimelineRow } from './task-brief';

const filled = (items: { k: string; v: React.ReactNode }[]) => items.filter((i) => i.v !== null && i.v !== undefined && i.v !== '');

/**
 * A cold contact's side of a task (cold outreach PLAN 4.3): how to reach them, where the outreach
 * stands, the firm's colleagues (CRM people marked "Already in CRM") and the cold history: calls
 * with their forms, emails and notes. There is no CRM link: the contact page is the record.
 */
export function ColdBriefPanel({ brief, timezone, callTemplate, gate }: { brief: ColdTaskBrief; timezone: string; callTemplate?: string | null; gate?: { blocked: string | null; warning: string | null } | null }) {
  const c = brief.contact;
  return <Surface flush>
    <Section title="Contact details" right={<Link href={brief.href} className="text-xs font-medium text-brand-700 hover:underline">Open contact</Link>}>
      <KeyValue items={filled([
        { k: 'Email', v: c.email ? <a href={`mailto:${c.email}`} className="block break-words text-brand-700 hover:underline [overflow-wrap:anywhere]">{c.email}</a> : null },
        // N013: a call ties to the task only when the task is a call step.
        { k: 'Phone', v: c.phone ? <CallButton phone={c.phone} template={callTemplate ?? null} taskId={brief.task.action === 'CALL' ? brief.task.id : null} sandboxContactId={c.id} blocked={gate?.blocked} warning={gate?.warning} label={c.phone} ariaLabel={`Call ${brief.name}`} className="inline-flex items-center gap-1 text-brand-700 hover:underline" /> : null },
        { k: 'City', v: [c.state, c.country].filter(Boolean).join(', ') || null },
        { k: 'Owner', v: c.ownerName ? `${c.ownerName}${c.ownerActive ? '' : ' (removed)'}` : 'Unclaimed' },
        { k: 'Pod', v: c.podName },
      ])} />
      {c.linkedinHref ? <div className="mt-3"><a href={c.linkedinHref} target="_blank" rel="noreferrer" className="btn-secondary btn-sm"><ActionIcon action="LINKEDIN_MESSAGE" size={13} />LinkedIn</a></div> : null}
    </Section>

    <Section title="Outreach progress" right={<Badge tone={enrollmentTone(brief.enrollment)}>{enrollmentStatusLabel(brief.enrollment)}</Badge>}>
      <KeyValue items={[
        { k: 'Outreach', v: brief.enrollment.campaignName ?? brief.enrollment.sequenceName },
        { k: 'Channels', v: [...new Set(brief.modules.map((module) => ACTION_LABELS[module.task.action]))].join(' + ') },
        { k: 'FO', v: brief.enrollment.foName }, { k: 'Started', v: formatLocalDate(brief.enrollment.startDate, 'long') },
      ]} />
      {brief.nextStep ? <div className="mt-4 rounded-xl bg-canvas p-3"><div className="mb-3 text-sm font-medium text-ink-900">Next step</div><RecordFields items={[{ label: 'Day', value: brief.nextStep.step.day }, { label: 'Scheduled', value: formatLocalDate(brief.nextStep.plannedDate) }, { label: 'Channels', value: [...new Set(brief.nextStep.step.actions.map((a) => ACTION_LABELS[a.type]))].join(' + ') }]} /></div> : <div className="mt-3"><Badge tone="gray">Final step</Badge></div>}
    </Section>

    <Section title="Cold history" right={<Link href={brief.href} className="text-xs font-medium text-brand-700 hover:underline">Full timeline</Link>}>
      {brief.history.length ? <ul className="max-h-96 overflow-y-auto scroll-thin">{brief.history.map((item) => <TimelineRow key={item.id} item={item} timezone={timezone} />)}</ul> : <div className="text-sm text-ink-500">No calls, emails or notes yet</div>}
    </Section>

    <Section title="Colleagues">
      {brief.colleagues.length ? <ul className="space-y-4">{brief.colleagues.map((colleague) => <li key={colleague.key} className="flex items-start gap-2.5"><Avatar name={colleague.name} shape="circle" size={28} /><div className="min-w-0 flex-1"><Link href={colleague.href} className="text-sm font-medium text-ink-900 hover:text-brand-700">{colleague.name}</Link>{colleague.jobTitle ? <div className="mt-1 text-xs text-ink-500">{colleague.jobTitle}</div> : null}{colleague.inCrm ? <div className="mt-2"><Badge tone="sky">Already in CRM</Badge></div> : null}</div></li>)}</ul> : <span className="text-sm text-ink-500">No one else at this firm yet</span>}
    </Section>
  </Surface>;
}
