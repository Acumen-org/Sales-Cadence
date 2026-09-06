import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { todayIn } from '@/lib/dates';
import { saveSequenceVersionAction, updateSequenceMetaAction } from '@/lib/actions/sequences';
import { parseSteps, describeAction } from '@/lib/sequences/steps';
import { sequenceFunnel, sequenceVersions } from '@/lib/sequences-query';
import { ActionForm } from '@/components/action-form';
import { ActionIcon } from '@/components/icons';
import { SequenceEditor } from '@/components/sequences/sequence-editor';
import { Badge, Card, Field, PageHeader, Tabs } from '@/components/ui';

export default async function SequenceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { tab = 'steps' } = await searchParams;
  const sequence = await prisma.sequence.findUnique({ where: { id }, include: { activeVersion: true } });
  if (!sequence) notFound();
  const steps = sequence.activeVersion ? parseSteps(sequence.activeVersion.steps) : [];
  const today = todayIn(user.timezone);
  const admin = isAdmin(user);
  const [funnel, versions, enrollmentsByVersion] = await Promise.all([
    sequenceFunnel(sequence.id, steps, today),
    sequenceVersions(sequence.id),
    prisma.enrollment.groupBy({ by: ['sequenceVersionId'], where: { sequenceId: sequence.id, status: { in: ['ACTIVE', 'PAUSED'] } }, _count: { _all: true } }),
  ]);
  const activeOnVersion = new Map(enrollmentsByVersion.map((r) => [r.sequenceVersionId, r._count._all]));
  const tabs = [
    { key: 'steps', label: 'Steps', href: `/sequences/${id}?tab=steps` },
    ...(admin ? [{ key: 'edit', label: 'Edit (new version)', href: `/sequences/${id}?tab=edit` }] : []),
    { key: 'versions', label: 'Version history', href: `/sequences/${id}?tab=versions`, count: versions.length },
  ];

  return (
    <>
      <PageHeader
        title={sequence.name}
        subtitle={
          <>
            v{sequence.activeVersion?.version ?? '-'} · {steps.length} steps over {steps.length ? steps[steps.length - 1].day : 0} days
            {sequence.description ? ` · ${sequence.description}` : ''}
            {sequence.archived ? <Badge tone="gray" className="ml-2">archived</Badge> : null}
          </>
        }
        actions={
          <Link href="/sequences" className="btn-secondary">
            All sequences
          </Link>
        }
      />
      <Tabs current={tab} tabs={tabs} />
      <div className="p-6">
        {tab === 'steps' ? (
          <Card title="Steps and funnel">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Step</th>
                  <th title="Enrollments currently on this step">Active</th>
                  <th title="Enrollments that completed at least one action here">Done</th>
                  <th title="Replied while on this step">Replied</th>
                  <th>Meetings</th>
                  <th title="Skipped tasks (bounced or wrong details)">Skipped / bounced</th>
                  <th>Overdue</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step, i) => {
                  const f = funnel[i];
                  return (
                    <tr key={step.id}>
                      <td className="whitespace-nowrap font-semibold text-slate-700">Day {step.day}</td>
                      <td>
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Step {i + 1}
                          {step.title ? ` · ${step.title}` : ''}
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {step.actions.map((a) => (
                            <li key={a.id} className="flex items-center gap-2 text-sm text-slate-800">
                              <ActionIcon action={a.type} size={14} className="text-slate-500" />
                              {describeAction(a)}
                              {a.subject ? <span className="text-xs text-slate-500">· {a.subject}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td>{f.active}</td>
                      <td>{f.done}</td>
                      <td>{f.replied}</td>
                      <td>{f.meeting}</td>
                      <td>
                        {f.skipped}
                        {f.bounced ? <span className="text-xs text-red-600"> ({f.bounced} bounced)</span> : null}
                      </td>
                      <td className={f.overdue ? 'font-medium text-red-600' : undefined}>{f.overdue}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ) : null}

        {tab === 'edit' && admin ? (
          <div className="max-w-4xl space-y-6">
            <Card title="Name and description">
              <ActionForm action={updateSequenceMetaAction} className="grid gap-4 p-4 md:grid-cols-[1fr_1fr_auto]">
                <input type="hidden" name="sequenceId" value={sequence.id} />
                <Field label="Name">
                  <input name="name" defaultValue={sequence.name} required className="w-full" />
                </Field>
                <Field label="Description">
                  <input name="description" defaultValue={sequence.description ?? ''} className="w-full" />
                </Field>
                <div className="flex items-end gap-3">
                  <label className="inline-flex items-center gap-1.5 text-sm font-normal text-slate-700">
                    <input type="checkbox" name="archived" defaultChecked={sequence.archived} className="h-4 w-4 rounded" /> Archived
                  </label>
                  <button type="submit" className="btn-secondary">
                    Save
                  </button>
                </div>
              </ActionForm>
            </Card>
            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-800">Steps (saving creates version {(sequence.activeVersion?.version ?? 0) + 1})</h2>
              <p className="mb-3 text-sm text-slate-600">
                Tasks already generated keep their version. Every active enrollment uses the new version from its next step onward.
              </p>
              <SequenceEditor sequenceId={sequence.id} initialSteps={steps} action={saveSequenceVersionAction} submitLabel="Save as new version" askChangeNote />
            </div>
          </div>
        ) : null}

        {tab === 'versions' ? (
          <div className="space-y-4">
            {versions.map((v) => (
              <Card
                key={v.id}
                title={
                  <>
                    Version {v.version}
                    {v.id === sequence.activeVersionId ? <Badge tone="green" className="ml-2">active</Badge> : null}
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {v.createdAt.toLocaleString('en-GB')} by {v.createdBy}
                      {v.changeNote ? ` · ${v.changeNote}` : ''} · {activeOnVersion.get(v.id) ?? 0} active enrollments on it · {v.tasks} tasks generated
                    </span>
                  </>
                }
              >
                <ol className="divide-y divide-slate-100">
                  {v.steps.map((step, i) => (
                    <li key={step.id} className="flex gap-4 px-4 py-2 text-sm">
                      <span className="w-14 shrink-0 text-xs font-semibold uppercase text-slate-500">Day {step.day}</span>
                      <span className="text-slate-800">
                        <span className="mr-2 text-slate-400">{i + 1}.</span>
                        {step.actions.map(describeAction).join(', then ')}
                      </span>
                    </li>
                  ))}
                </ol>
              </Card>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
