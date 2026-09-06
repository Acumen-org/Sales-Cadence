import type { TaskBrief } from '@/lib/brief';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { ActionIcon, IconExternal } from '@/components/icons';
import { Badge, ENROLLMENT_TONE, KeyValue, Notice } from '@/components/ui';
import { CopyButton } from '@/components/copy-button';

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-slate-100 px-4 py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** The right-hand panel: everything the FO needs before touching this person. */
export function TaskBriefPanel({ brief, timezone }: { brief: TaskBrief; timezone: string }) {
  const p = brief.person;
  const fullTemplate = [brief.action.subject ? `Subject: ${brief.action.subject}` : null, brief.action.body].filter(Boolean).join('\n\n');
  return (
    <div className="card overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-slate-900">{brief.personName}</div>
          <div className="truncate text-sm text-slate-600">
            {p.jobTitle ?? 'Unknown title'}
            {p.companyName ? ` · ${p.companyName}` : ''}
          </div>
        </div>
        {brief.twentyUrl ? (
          <a href={brief.twentyUrl} target="_blank" rel="noreferrer" className="btn-ghost btn-sm shrink-0" title="Open in Twenty">
            <IconExternal size={14} /> Twenty
          </a>
        ) : null}
      </div>

      {brief.warnings.map((w) => (
        <div key={w} className="px-4 pt-3">
          <Notice tone="warn">{w}</Notice>
        </div>
      ))}

      <Section title="Person">
        <KeyValue
          items={[
            { k: 'Email', v: p.email ? <a className="text-brand-700 hover:underline" href={`mailto:${p.email}`}>{p.email}</a> : null },
            { k: 'Phone', v: p.phone ? <a className="text-brand-700 hover:underline" href={`tel:${p.phone}`}>{p.phone}</a> : null },
            { k: 'LinkedIn', v: p.linkedinUrl ? <a className="text-brand-700 hover:underline" href={p.linkedinUrl} target="_blank" rel="noreferrer">{p.linkedinUrl.replace(/^https?:\/\/(www\.)?/, '')}</a> : null },
            { k: 'Where we met', v: p.eventSource },
            { k: 'City', v: p.city },
            { k: 'Pod', v: p.podOwner },
            { k: 'Tags', v: p.tags.length ? p.tags.join(', ') : null },
          ]}
        />
      </Section>

      <Section title="Enrollment">
        <KeyValue
          items={[
            { k: 'Sequence', v: `${brief.enrollment.sequenceName} · v${brief.enrollment.version}` },
            { k: 'Campaign', v: brief.enrollment.campaignName },
            { k: 'FO', v: brief.enrollment.foName },
            { k: 'Started', v: formatLocalDate(brief.enrollment.startDate, 'long') },
            { k: 'Status', v: <Badge tone={ENROLLMENT_TONE[brief.enrollment.status] ?? 'gray'}>{brief.enrollment.status.toLowerCase()}</Badge> },
            { k: 'Clock', v: brief.enrollment.shiftDays ? `shifted ${brief.enrollment.shiftDays} day${brief.enrollment.shiftDays === 1 ? '' : 's'}` : 'on plan' },
          ]}
        />
      </Section>

      <Section title={`This step: ${brief.action.label}`} right={fullTemplate ? <CopyButton text={fullTemplate} label="Copy" className="btn-ghost btn-sm" /> : null}>
        {brief.action.subject ? <div className="mb-1 text-sm font-medium text-slate-800">Subject: {brief.action.subject}</div> : null}
        {brief.action.body ? (
          <pre className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 font-sans text-sm text-slate-800">{brief.action.body}</pre>
        ) : (
          <p className="text-sm text-slate-500">No template for this action.</p>
        )}
        {brief.alternative ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-slate-600">Or: {brief.alternative.label}</summary>
            {brief.alternative.subject ? <div className="mt-1 text-sm font-medium text-slate-800">Subject: {brief.alternative.subject}</div> : null}
            <pre className="mt-1 whitespace-pre-wrap rounded-md bg-slate-50 p-3 font-sans text-sm text-slate-800">{brief.alternative.body}</pre>
          </details>
        ) : null}
      </Section>

      <Section title="Last touches">
        {brief.touches.length === 0 ? (
          <p className="text-sm text-slate-500">No touches recorded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {brief.touches.map((t) => (
              <li key={t.id} className="flex items-start gap-2 text-sm">
                <span className={t.direction === 'INBOUND' ? 'mt-0.5 text-emerald-600' : 'mt-0.5 text-slate-500'}>
                  <ActionIcon action={t.channel} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-slate-800">{t.summary}</span>
                  <span className="block text-xs text-slate-500">
                    {t.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} · {formatInstant(t.occurredAt, timezone)}
                    {t.actorLabel ? ` · ${t.actorLabel}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Latest notes in Twenty">
        {brief.notes.length === 0 ? (
          <p className="text-sm text-slate-500">No notes.</p>
        ) : (
          <ul className="space-y-1.5">
            {brief.notes.map((n) => (
              <li key={n.id} className="text-sm">
                <div className="font-medium text-slate-800">{n.title}</div>
                <div className="text-xs text-slate-500">
                  {formatInstant(n.createdAt, timezone)}
                  {n.createdByName ? ` · ${n.createdByName}` : ''}
                </div>
                {n.bodyMarkdown ? <div className="mt-0.5 line-clamp-2 text-slate-600">{n.bodyMarkdown}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Colleagues at ${p.companyName ?? 'company'}`}>
        {brief.colleagues.length === 0 ? (
          <p className="text-sm text-slate-500">Nobody else known here.</p>
        ) : (
          <ul className="space-y-1">
            {brief.colleagues.map((c) => (
              <li key={c.personId} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="text-slate-800">{c.name}</span>
                  {c.jobTitle ? <span className="text-slate-500"> · {c.jobTitle}</span> : null}
                </span>
                <span className="shrink-0 text-xs text-slate-500">
                  {c.status ? <Badge tone={c.status === 'DND' ? 'red' : ENROLLMENT_TONE[c.status] ?? 'gray'}>{c.status.toLowerCase()}</Badge> : 'not enrolled'}
                  {c.foName ? ` · ${c.foName}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Open opportunities">
        {brief.opportunities.length === 0 ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {brief.opportunities.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2">
                <span className="text-slate-800">{o.name}</span>
                <Badge tone="purple">{o.stage ?? 'open'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Next step">
        {brief.nextStep ? (
          <p className="text-sm text-slate-800">
            Day {brief.nextStep.step.day} · {formatLocalDate(brief.nextStep.plannedDate, 'long')}: {brief.nextStep.description}
          </p>
        ) : (
          <p className="text-sm text-slate-500">This is the last step of the sequence.</p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          Step {brief.stepIndex + 1} of {brief.stepCount} · {ACTION_LABELS[brief.task.action]}
          {brief.task.altAction ? ` or ${ACTION_LABELS[brief.task.altAction]}` : ''}
        </p>
      </Section>
    </div>
  );
}
