import Link from 'next/link';
import type { BriefTimelineItem, TaskBrief } from '@/lib/brief';
import { compareLocalDates, formatInstant, formatLocalDate, type LocalDate } from '@/lib/dates';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { ActionIcon, IconExternal, IconNote } from '@/components/icons';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { Avatar, Badge, contactWarnings, crmStanding, ENROLLMENT_TONE, enrollmentStatusLabel, KeyValue, Notice, RecordFields, Surface, TierBadge, type BadgeTone } from '@/components/ui';

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return <section className="border-b border-line px-4 py-4 last:border-b-0"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-ink-900">{title}</h3>{right}</div>{children}</section>;
}
const filled = (items: { k: string; v: React.ReactNode }[]) => items.filter((i) => i.v !== null && i.v !== undefined && i.v !== '');
function dueTone(due: LocalDate, today: LocalDate): BadgeTone { const comparison = compareLocalDates(due, today); return comparison < 0 ? 'red' : comparison === 0 ? 'amber' : 'gray'; }
const KIND_ICON: Record<BriefTimelineItem['kind'], string> = { email: 'EMAIL', call: 'CALL', linkedin: 'LINKEDIN_MESSAGE', note: 'NOTE', meeting: 'MEETING', state: 'STATE' };

function TimelineRow({ item, timezone }: { item: BriefTimelineItem; timezone: string }) {
  const icon = KIND_ICON[item.kind];
  return <li className="relative pl-7"><span aria-hidden className="absolute left-[7px] top-2 h-full w-px bg-line" /><span aria-hidden className="absolute left-0 top-1 rounded-full bg-white text-brand-700">{icon === 'NOTE' ? <IconNote size={15} /> : icon === 'STATE' || icon === 'MEETING' ? <span className="block h-3.5 w-3.5 rounded-full border-2 border-current" /> : <ActionIcon action={icon} size={15} />}</span>
    <div className="space-y-2 pb-5"><div className="text-sm font-medium leading-relaxed text-ink-900">{item.title}</div>{item.detail ? <details><summary className="cursor-pointer text-xs font-medium text-brand-700">Details</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-800">{item.detail}</p></details> : null}<div className="flex flex-wrap gap-2"><time dateTime={item.at.toISOString()} className="text-xs text-ink-500">{formatInstant(item.at, timezone)}</time>{item.direction === 'in' ? <Badge tone="green">Inbound</Badge> : null}</div>{item.actor ? <div className="text-xs"><span className="text-ink-500">By</span><strong className="ml-2 text-ink-900">{item.actor}</strong></div> : null}</div>
  </li>;
}

/** The selected contact's CRM context. Full emails and notes follow in CrmHistory. */
export function TaskBriefPanel({ brief, timezone }: { brief: TaskBrief; timezone: string }) {
  const person = brief.person;
  const standing = crmStanding(person);
  const warnings = contactWarnings(person);
  const localActivity = brief.timeline.filter((item) => item.kind !== 'email' && item.kind !== 'note');
  const campaign = brief.task.enrollment.campaign;
  return <Surface flush>
    <header className="space-y-4 border-b border-line bg-canvas/50 p-4"><div className="flex items-start gap-3"><Avatar name={brief.personName} shape="circle" size={40} /><div className="min-w-0 flex-1"><Link href={`/people/${person.id}`} className="text-base font-medium text-ink-900 hover:text-brand-700">{brief.personName}</Link><div className="mt-1 text-sm text-ink-500">{person.jobTitle ?? 'Title missing'}</div></div>{brief.twentyUrl ? <a href={brief.twentyUrl} target="_blank" rel="noreferrer" className="btn-icon shrink-0" aria-label="Open contact in Twenty"><IconExternal size={15} /></a> : null}</div>
      {person.companyName ? <Link href={person.companyId ? `/accounts/${person.companyId}` : `/people/${person.id}`} className="block font-medium text-brand-700 hover:underline">{person.companyName}</Link> : null}
      <div className="flex flex-wrap gap-1.5"><Badge tone={standing.tone} dot>{standing.label}</Badge>{person.tier ? <TierBadge tier={person.tier} /> : null}{warnings.map((warning) => <Badge key={warning.label} tone={warning.tone}>{warning.label}</Badge>)}</div>
    </header>
    {brief.warnings.length ? <div className="p-4"><Notice tone="warn">Some CRM information is temporarily unavailable. Cached contact data is shown.</Notice></div> : null}

    <Section title="Contact details">
      <KeyValue items={filled([
        // break-all split the address mid-word in a narrow rail; it truncates with the full
        // value on hover instead, and the link still carries all of it.
        { k: 'Email', v: person.email ? <a href={`mailto:${person.email}`} className="block break-words text-brand-700 hover:underline [overflow-wrap:anywhere]">{person.email}</a> : null },
        { k: 'Other emails', v: person.additionalEmails.length ? <span className="space-y-1">{person.additionalEmails.map((email) => <a key={email} href={`mailto:${email}`} className="block break-all text-brand-700 hover:underline">{email}</a>)}</span> : null },
        { k: 'Phone', v: person.phone ? <a href={`tel:${person.phone}`} className="text-brand-700 hover:underline">{person.phone}</a> : null },
        { k: 'Other phone', v: person.additionalPhone ? <a href={`tel:${person.additionalPhone}`} className="text-brand-700 hover:underline">{person.additionalPhone}</a> : null },
        { k: 'City', v: person.city }, { k: 'Owner', v: brief.ownerName }, { k: 'Pod', v: brief.podName ?? (person.podOwner ? optionLabel(person.podOwner) : null) },
      ])} />
      <div className="mt-3 flex flex-wrap gap-2">{person.linkedinUrl ? <a href={person.linkedinUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm"><ActionIcon action="LINKEDIN_MESSAGE" size={13} />LinkedIn</a> : null}{person.xUrl ? <a href={person.xUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">X profile<IconExternal size={12} /></a> : null}<Link href={`/people/${person.id}`} className="btn-ghost btn-sm">Full overview</Link></div>
    </Section>

    {person.nextAction || person.nextActionDueDate || person.nextStep || person.lastNote ? <Section title="CRM next action">
      <RecordFields items={[
        { label: 'Action', value: person.nextAction },
        { label: 'Due', value: person.nextActionDueDate ? <Badge tone={dueTone(person.nextActionDueDate, brief.today)}>{formatLocalDate(person.nextActionDueDate, 'long')}</Badge> : null },
        { label: 'Channel', value: person.nextStep ? optionLabel(person.nextStep) : null },
        { label: 'POC due', value: person.nextActionDueDatePoc ? formatLocalDate(person.nextActionDueDatePoc) : null },
      ]} />
      {person.lastNote ? <details className="mt-4 rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm font-medium text-ink-900">Latest CRM note</summary><div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-ink-800">{person.lastNote}</div></details> : null}
    </Section> : null}

    <Section title="CRM profile"><KeyValue items={filled([
      { k: 'Type', v: optionLabels(person.contactType, ' / ') || null }, { k: 'Pipeline', v: person.pipelineStage ? optionLabel(person.pipelineStage) : null },
      { k: 'Product interest', v: optionLabels(person.productInterest) || null }, { k: 'Primary product', v: person.primaryProduct ? optionLabel(person.primaryProduct) : null },
      { k: 'CRM campaigns', v: optionLabels(person.campaigns) || null }, { k: 'Lead source', v: optionLabels(person.leadSource) || null }, { k: 'Source notes', v: person.leadSourceNotes },
      { k: 'Calling list', v: person.onCallingList ? 'Included' : null }, { k: 'Deal signal', v: person.dealSignalStrength ? optionLabel(person.dealSignalStrength) : null },
    ])} /></Section>

    <Section title="CRM tags"><div className="flex flex-wrap gap-1.5">{person.tags.map((tag) => <Badge key={tag} tone="gray">{optionLabel(tag)}</Badge>)}{person.listCategory ? <Badge tone="gray">{optionLabel(person.listCategory)}</Badge> : null}{!person.tags.length && !person.listCategory ? <span className="text-sm text-ink-500">No tags</span> : null}</div></Section>

    {person.recordingUrl || person.meetingUrl ? <Section title="Meetings"><div className="flex flex-wrap gap-2">{person.meetingUrl ? <a href={person.meetingUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">Meeting link<IconExternal size={12} /></a> : null}{person.recordingUrl ? <Link href={`/meetings/new?personId=${person.id}&url=${encodeURIComponent(person.recordingUrl)}`} className="btn-secondary btn-sm">Add recording</Link> : null}</div>{person.bookingId ? <div className="mt-3"><RecordFields items={[{ label: 'Booking ID', value: person.bookingId }]} /></div> : null}</Section> : null}

    <Section title="Sequence progress" right={<Badge tone={ENROLLMENT_TONE[brief.enrollment.status] ?? 'gray'}>{enrollmentStatusLabel(brief.enrollment)}</Badge>}>
      <KeyValue items={[
        { k: 'Sequence', v: <Link href={`/sequences/${brief.task.enrollment.sequence.id}`} className="text-brand-700 hover:underline">{brief.enrollment.sequenceName}</Link> },
        { k: 'Campaign', v: campaign ? <Link href={`/campaigns/${campaign.id}`} className="text-brand-700 hover:underline">{campaign.name}</Link> : null },
        { k: 'Step', v: <span className="font-medium">{brief.stepIndex + 1} / {brief.stepCount}</span> },
        { k: 'Channels', v: [...new Set(brief.modules.map((module) => ACTION_LABELS[module.task.action]))].join(' + ') },
        { k: 'Assigned to', v: brief.enrollment.foName }, { k: 'Started', v: formatLocalDate(brief.enrollment.startDate, 'long') },
      ]} />
      {brief.nextStep ? <div className="mt-4 rounded-xl bg-canvas p-3"><div className="mb-3 text-sm font-medium text-ink-900">Next touchpoint</div><RecordFields items={[{ label: 'Business day', value: brief.nextStep.step.day }, { label: 'Scheduled', value: formatLocalDate(brief.nextStep.plannedDate) }, { label: 'Channels', value: brief.nextStep.description }]} /></div> : <div className="mt-3"><Badge tone="gray">Final touchpoint</Badge></div>}
      <Link href={`/people/${person.id}?tab=sequences`} className="btn-ghost btn-sm mt-3">All campaigns & sequence history</Link>
    </Section>

    <Section title="Recent activity" right={<Link href={`/people/${person.id}?tab=activity`} className="text-xs font-medium text-brand-700 hover:underline">Full timeline</Link>}>
      {person.lastCallAt || person.lastEmailAt ? <div className="mb-4"><RecordFields items={[{ label: 'Last call', value: person.lastCallAt ? formatInstant(new Date(person.lastCallAt), timezone) : null }, { label: 'Last email', value: person.lastEmailAt ? formatInstant(new Date(person.lastEmailAt), timezone) : null }]} /></div> : null}
      {localActivity.length ? <ul className="max-h-96 overflow-y-auto scroll-thin">{localActivity.map((item) => <TimelineRow key={item.id} item={item} timezone={timezone} />)}</ul> : <div className="text-sm text-ink-500">No calls or sequence events recorded</div>}
    </Section>

    {brief.opportunities.length ? <Section title="Open opportunities"><ul className="space-y-3">{brief.opportunities.map((opportunity) => <li key={opportunity.id} className="flex items-center justify-between gap-2 text-sm"><span className="font-medium text-ink-900">{opportunity.name}</span><Badge tone="purple">{opportunity.stage ?? 'Open'}</Badge></li>)}</ul></Section> : null}
    <Section title="Colleagues" right={person.companyId ? <Link href={`/accounts/${person.companyId}?tab=people`} className="text-xs font-medium text-brand-700 hover:underline">All company contacts</Link> : null}>
      {brief.colleagues.length ? <ul className="space-y-4">{brief.colleagues.map((colleague) => <li key={colleague.personId} className="flex items-start gap-2.5"><Avatar name={colleague.name} shape="circle" size={28} /><div className="min-w-0 flex-1"><Link href={`/people/${colleague.personId}`} className="text-sm font-medium text-ink-900 hover:text-brand-700">{colleague.name}</Link>{colleague.jobTitle ? <div className="mt-1 text-xs text-ink-500">{colleague.jobTitle}</div> : null}{colleague.status ? <div className="mt-2"><Badge tone={colleague.status === 'DND' ? 'red' : ENROLLMENT_TONE[colleague.status] ?? 'gray'}>{enrollmentStatusLabel({ status: colleague.status, exitReason: colleague.exitReason })}</Badge></div> : null}</div></li>)}</ul> : <span className="text-sm text-ink-500">No other contacts linked</span>}
    </Section>
  </Surface>;
}
