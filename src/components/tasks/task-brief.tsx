import Link from 'next/link';
import type { TaskBrief } from '@/lib/brief';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { ActionIcon, IconExternal } from '@/components/icons';
import { Avatar, Badge, DotTimeline, ENROLLMENT_TONE, enrollmentStatusLabel, KeyValue, Notice, personStage, Surface } from '@/components/ui';
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

/** The right-hand brief: everything the FO needs before touching this person. */
export function TaskBriefPanel({ brief, timezone }: { brief: TaskBrief; timezone: string }) {
  const p = brief.person;
  const stage = personStage(p, { status: brief.enrollment.status });
  const points = brief.touches.map((t) => ({ at: t.occurredAt.getTime(), lane: t.direction === 'INBOUND' ? ('in' as const) : ('out' as const) }));

  return (
    <Surface flush>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={brief.personName} shape="circle" size={38} />
          <div className="min-w-0">
            <Link href={`/people/${p.id}`} className="block truncate text-[15px] font-semibold text-ink-900 hover:text-brand-700">
              {brief.personName}
            </Link>
            <div className="truncate text-[12.5px] text-ink-500">
              {p.jobTitle ?? 'Unknown title'}
              {p.companyName ? ` · ${p.companyName}` : ''}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Badge tone={stage.tone} dot>
                {stage.label}
              </Badge>
              {p.dnd ? <Badge tone="red">DND</Badge> : null}
              {p.badEmail ? <Badge tone="amber">bad email</Badge> : null}
              {p.badPhone ? <Badge tone="amber">bad phone</Badge> : null}
            </div>
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

      <Section title="Contact">
        <div className="flex flex-wrap gap-1.5">
          {p.email ? (
            <a href={`mailto:${p.email}`} className="chip-muted" title={p.email}>
              <ActionIcon action="EMAIL" size={13} /> Email
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
        <div className="mt-3">
          <KeyValue
            items={[
              { k: 'Where we met', v: p.eventSource },
              { k: 'City', v: p.city },
              { k: 'Pod', v: p.podOwner },
              { k: 'Tags', v: p.tags.length ? p.tags.join(', ') : null },
            ]}
          />
        </div>
      </Section>

      <Section title="Enrollment">
        <KeyValue
          items={[
            { k: 'Sequence', v: `${brief.enrollment.sequenceName} · v${brief.enrollment.version}` },
            { k: 'Campaign', v: brief.enrollment.campaignName },
            { k: 'FO', v: brief.enrollment.foName },
            { k: 'Started', v: formatLocalDate(brief.enrollment.startDate, 'long') },
            { k: 'Status', v: <Badge tone={ENROLLMENT_TONE[brief.enrollment.status] ?? 'gray'}>{enrollmentStatusLabel({ status: brief.enrollment.status })}</Badge> },
            { k: 'Clock', v: brief.enrollment.shiftDays ? `shifted ${brief.enrollment.shiftDays} day${brief.enrollment.shiftDays === 1 ? '' : 's'}` : 'on plan' },
          ]}
        />
      </Section>

      {/* The step's own copy is shown in the task pane; only the either/or alternative needs a home here. */}
      {brief.alternative ? (
        <Section title={`Or instead: ${brief.alternative.label}`} right={<CopyButton text={[brief.alternative.subject ? `Subject: ${brief.alternative.subject}` : null, brief.alternative.body].filter(Boolean).join('\n\n')} label="Copy" className="btn-ghost btn-sm" />}>
          {brief.alternative.subject ? <div className="mb-1 text-[13px] font-medium text-ink-900">Subject: {brief.alternative.subject}</div> : null}
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-canvas/70 p-3 font-sans text-[12.5px] leading-relaxed text-ink-700 scroll-thin">{brief.alternative.body}</pre>
        </Section>
      ) : null}

      <Section title="Touch history" right={points.length ? <span className="text-[11px] text-ink-400">30 days</span> : null}>
        {points.length ? <DotTimeline points={points} width={330} /> : null}
        {brief.touches.length === 0 ? (
          <p className="text-[13px] text-ink-400">No touches recorded yet.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {brief.touches.slice(0, 5).map((t) => (
              <li key={t.id} className="flex items-start gap-2.5 text-[13px]">
                <span className={t.direction === 'INBOUND' ? 'mt-0.5 text-emerald-600' : 'mt-0.5 text-ink-400'}>
                  <ActionIcon action={t.channel} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-ink-700">{t.summary}</span>
                  <span className="block text-[11.5px] text-ink-400">
                    {t.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} · {formatInstant(t.occurredAt, timezone)}
                    {t.actorLabel ? ` · ${t.actorLabel}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {brief.notes.length ? (
        <Section title="Latest notes in Twenty">
          <ul className="space-y-2">
            {brief.notes.slice(0, 4).map((n) => (
              <li key={n.id} className="text-[13px]">
                <div className="font-medium text-ink-800">{n.title}</div>
                <div className="text-[11.5px] text-ink-400">
                  {formatInstant(n.createdAt, timezone)}
                  {n.createdByName ? ` · ${n.createdByName}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={`Colleagues at ${p.companyName ?? 'company'}`}>
        {brief.colleagues.length === 0 ? (
          <p className="text-[13px] text-ink-400">Nobody else known here.</p>
        ) : (
          <ul className="space-y-1.5">
            {brief.colleagues.slice(0, 6).map((c) => (
              <li key={c.personId} className="flex items-center justify-between gap-2 text-[13px]">
                <Link href={`/people/${c.personId}`} className="flex min-w-0 items-center gap-2 hover:text-brand-700">
                  <Avatar name={c.name} shape="circle" size={22} />
                  <span className="min-w-0 truncate text-ink-700">{c.name}</span>
                </Link>
                <span className="shrink-0">{c.status ? <Badge tone={c.status === 'DND' ? 'red' : ENROLLMENT_TONE[c.status] ?? 'gray'}>{enrollmentStatusLabel({ status: c.status })}</Badge> : <span className="text-[11.5px] text-ink-300">not enrolled</span>}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {brief.opportunities.length ? (
        <Section title="Open opportunities">
          <ul className="space-y-1 text-[13px]">
            {brief.opportunities.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2">
                <span className="text-ink-700">{o.name}</span>
                <Badge tone="purple">{o.stage ?? 'open'}</Badge>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Next step">
        {brief.nextStep ? (
          <p className="text-[13px] text-ink-700">
            <span className="font-medium">Day {brief.nextStep.step.day}</span> · {formatLocalDate(brief.nextStep.plannedDate, 'long')}: {brief.nextStep.description}
          </p>
        ) : (
          <p className="text-[13px] text-ink-400">This is the last step of the sequence.</p>
        )}
        <p className="mt-1 text-[11.5px] text-ink-400">
          Step {brief.stepIndex + 1} of {brief.stepCount} · {ACTION_LABELS[brief.task.action]}
          {brief.task.altAction ? ` or ${ACTION_LABELS[brief.task.altAction]}` : ''}
        </p>
      </Section>
    </Surface>
  );
}
