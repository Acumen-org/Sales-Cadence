import Link from 'next/link';
import type { BriefTimelineItem, TaskBrief } from '@/lib/brief';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { ActionIcon, IconBolt, IconExternal, IconInfo, IconNote } from '@/components/icons';
import { Avatar, Badge, DotTimeline, ENROLLMENT_TONE, enrollmentStatusLabel, KeyValue, Notice, Surface } from '@/components/ui';
import { CopyButton } from '@/components/copy-button';

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3.5 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

const KIND_ICON: Record<BriefTimelineItem['kind'], string> = {
  email: 'EMAIL',
  call: 'CALL',
  linkedin: 'LINKEDIN_MESSAGE',
  note: 'NOTE',
  meeting: 'MEETING',
  state: 'STATE',
};

function TimelineRow({ item, timezone }: { item: BriefTimelineItem; timezone: string }) {
  const tone = item.direction === 'in' ? 'text-emerald-600' : item.direction === 'out' ? 'text-ink-400' : 'text-ink-300';
  const icon = KIND_ICON[item.kind];
  return (
    <li className="relative pl-6">
      {/* The rail and its dot: one vertical line through the whole history. */}
      <span aria-hidden className="absolute left-[7px] top-0 h-full w-px bg-line" />
      <span aria-hidden className={`absolute left-0 top-[3px] flex h-[15px] w-[15px] items-center justify-center rounded-full bg-white ${tone}`}>
        {icon === 'NOTE' ? <IconNote size={11} /> : icon === 'STATE' || icon === 'MEETING' ? <span className="h-[7px] w-[7px] rounded-full border border-current" /> : <ActionIcon action={icon} size={11} />}
      </span>
      <div className="pb-3">
        <p className="text-[12.5px] leading-snug text-ink-800">
          {item.direction === 'in' ? <span className="font-medium text-emerald-700">In · </span> : null}
          {item.title}
        </p>
        {item.detail ? <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-ink-500">{item.detail}</p> : null}
        <p className="mt-0.5 text-[11px] text-ink-400">
          {formatInstant(item.at, timezone)}
          {item.actor ? ` · ${item.actor}` : ''}
        </p>
      </div>
    </li>
  );
}

/**
 * The right-hand panel: who this person is and everything we know about them, so an FO can
 * personalise the message on the left without opening the CRM. Their own stance and stage are
 * deliberately absent: a label Cadence guessed is noise next to the record itself.
 */
export function TaskBriefPanel({ brief, timezone }: { brief: TaskBrief; timezone: string }) {
  const p = brief.person;
  const points = brief.touches.map((t) => ({ at: t.occurredAt.getTime(), lane: t.direction === 'INBOUND' ? ('in' as const) : ('out' as const) }));

  return (
    <div className="space-y-3">
      <Surface flush>
        <div className="flex items-start justify-between gap-3 border-b border-line bg-gradient-to-b from-canvas/70 to-white px-4 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <Avatar name={brief.personName} shape="circle" size={40} />
            <div className="min-w-0">
              <Link href={`/people/${p.id}`} className="block truncate text-[15.5px] font-semibold tracking-[-0.01em] text-ink-900 hover:text-brand-700">
                {brief.personName}
              </Link>
              <div className="truncate text-[12.5px] text-ink-500">{p.jobTitle ?? 'Unknown title'}</div>
              {p.companyName ? (
                <Link href={p.companyId ? `/accounts/${p.companyId}` : `/people/${p.id}`} className="truncate text-[12.5px] font-medium text-brand-700 hover:underline">
                  {p.companyName}
                </Link>
              ) : null}
              {p.dnd || p.optedOut || p.badEmail || p.badPhone ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {p.dnd ? <Badge tone="red">do not contact</Badge> : null}
                  {p.optedOut ? <Badge tone="red">opted out</Badge> : null}
                  {p.badEmail ? <Badge tone="amber">bad email</Badge> : null}
                  {p.badPhone ? <Badge tone="amber">bad phone</Badge> : null}
                </div>
              ) : null}
            </div>
          </div>
          {brief.twentyUrl ? (
            <a href={brief.twentyUrl} target="_blank" rel="noreferrer" className="btn-icon shrink-0" title="Open in Twenty" aria-label="Open in Twenty">
              <IconExternal size={15} />
            </a>
          ) : null}
        </div>

        {brief.warnings.map((w) => (
          <div key={w} className="px-4 pt-3">
            <Notice tone="warn">{w}</Notice>
          </div>
        ))}

        <Section title="Reach them">
          <div className="flex flex-wrap gap-1.5">
            {p.email ? (
              <a href={`mailto:${p.email}`} className="chip-muted" title={p.email}>
                <ActionIcon action="EMAIL" size={13} /> {p.email}
              </a>
            ) : null}
            {p.phone ? (
              <a href={`tel:${p.phone}`} className="chip-muted" title={p.phone}>
                <ActionIcon action="CALL" size={13} /> {p.phone}
              </a>
            ) : null}
            {p.linkedinUrl ? (
              <a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="chip-muted">
                <ActionIcon action="LINKEDIN_MESSAGE" size={13} /> LinkedIn
              </a>
            ) : null}
          </div>
        </Section>

        {/* Tags come from Twenty and are how the team labels people, so they get their own row. */}
        <Section title="Tags in Twenty">
          {p.tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {p.tags.map((t) => (
                <span key={t} className="rounded-md border border-line bg-canvas px-2 py-0.5 text-[11.5px] font-medium text-ink-700">
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-ink-400">No tags on this person in Twenty.</p>
          )}
          <div className="mt-3">
            <KeyValue
              items={[
                { k: 'Where we met', v: p.eventSource },
                { k: 'City', v: p.city },
                { k: 'Pod', v: p.podOwner },
              ]}
            />
          </div>
        </Section>

        <Section title="Everything so far" right={points.length ? <span className="text-[11px] text-ink-400">30 days</span> : null}>
          {points.length ? <DotTimeline points={points} width={330} /> : null}
          {brief.timeline.length === 0 ? (
            <p className="text-[12.5px] text-ink-400">Nothing recorded yet. This is the first touch.</p>
          ) : (
            <ul className="mt-2 max-h-[340px] overflow-y-auto scroll-thin">
              {brief.timeline.map((item) => (
                <TimelineRow key={item.id} item={item} timezone={timezone} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Where they are in the sequence">
          <KeyValue
            items={[
              { k: 'Plan', v: `${brief.enrollment.sequenceName} · v${brief.enrollment.version}` },
              { k: 'Campaign', v: brief.enrollment.campaignName },
              { k: 'Step', v: `${brief.stepIndex + 1} of ${brief.stepCount} · ${ACTION_LABELS[brief.task.action]}${brief.task.altAction ? ` or ${ACTION_LABELS[brief.task.altAction]}` : ''}` },
              { k: 'FO', v: brief.enrollment.foName },
              { k: 'Started', v: formatLocalDate(brief.enrollment.startDate, 'long') },
              { k: 'State', v: <Badge tone={ENROLLMENT_TONE[brief.enrollment.status] ?? 'gray'}>{enrollmentStatusLabel({ status: brief.enrollment.status })}</Badge> },
              { k: 'Clock', v: brief.enrollment.shiftDays ? `shifted ${brief.enrollment.shiftDays} day${brief.enrollment.shiftDays === 1 ? '' : 's'}` : 'on plan' },
              {
                k: 'Next',
                v: brief.nextStep ? `Day ${brief.nextStep.step.day} · ${formatLocalDate(brief.nextStep.plannedDate)} · ${brief.nextStep.description}` : 'This is the last step.',
              },
            ]}
          />
        </Section>

        {/* The either/or alternative has no home on the left, where one message is being written. */}
        {brief.alternative ? (
          <Section
            title={`Or instead: ${brief.alternative.label}`}
            right={<CopyButton text={[brief.alternative.subject ? `Subject: ${brief.alternative.subject}` : null, brief.alternative.body].filter(Boolean).join('\n\n')} label="Copy" className="btn-ghost btn-sm" />}
          >
            {brief.alternative.subject ? <div className="mb-1 text-[12.5px] font-medium text-ink-900">Subject: {brief.alternative.subject}</div> : null}
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-canvas/70 p-3 font-sans text-[12.5px] leading-relaxed text-ink-700 scroll-thin">{brief.alternative.body}</pre>
          </Section>
        ) : null}

        {brief.opportunities.length ? (
          <Section title="Open opportunities">
            <ul className="space-y-1 text-[12.5px]">
              {brief.opportunities.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2">
                  <span className="text-ink-700">{o.name}</span>
                  <Badge tone="purple">{o.stage ?? 'open'}</Badge>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title={`Colleagues at ${p.companyName ?? 'this company'}`}>
          {brief.colleagues.length === 0 ? (
            <p className="text-[12.5px] text-ink-400">Nobody else known here.</p>
          ) : (
            <ul className="space-y-1.5">
              {brief.colleagues.slice(0, 6).map((c) => (
                <li key={c.personId} className="flex items-center justify-between gap-2 text-[12.5px]">
                  <Link href={`/people/${c.personId}`} className="flex min-w-0 items-center gap-2 hover:text-brand-700">
                    <Avatar name={c.name} shape="circle" size={22} />
                    <span className="min-w-0 truncate text-ink-700">{c.name}</span>
                  </Link>
                  <span className="shrink-0">
                    {c.status ? (
                      <Badge tone={c.status === 'DND' ? 'red' : ENROLLMENT_TONE[c.status] ?? 'gray'}>{enrollmentStatusLabel({ status: c.status })}</Badge>
                    ) : (
                      <span className="text-[11.5px] text-ink-300">not enrolled</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </Surface>

      {/* Reserved for the analyzer. Empty on purpose: no model is connected yet. */}
      <Surface flush>
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-brand-500">
            <IconBolt size={15} />
          </span>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Suggested approach</h3>
        </div>
        <div className="px-4 py-3.5">
          <div className="flex gap-2 rounded-lg bg-brand-50/60 px-3 py-2.5 text-[12px] leading-snug text-ink-600">
            <span className="mt-[1px] shrink-0 text-brand-500">
              <IconInfo size={13} />
            </span>
            <span>No language model is connected yet. When one is, this panel reads the history above and suggests what to say.</span>
          </div>
          <ul className="mt-2.5 space-y-1 text-[11.5px] text-ink-400">
            {['What has and has not worked with this person', 'An angle drawn from their replies and meetings', 'A draft you can accept into the message on the left'].map((line) => (
              <li key={line} className="flex gap-1.5">
                <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-300" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      </Surface>
    </div>
  );
}
