import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, canManageEnrollment, toActor, visiblePodIds } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { cachedPersonName, upsertPersonCache } from '@/lib/person-cache';
import { describeStep, parseSteps } from '@/lib/sequences/steps';
import { getTwentyConnection } from '@/lib/settings';
import { getTwentyClient } from '@/lib/twenty';
import type { TwentyNote, TwentyOpportunity } from '@/lib/twenty/types';
import { twentyPersonUrl } from '@/lib/twenty/urls';
import { ActionIcon, IconExternal } from '@/components/icons';
import { PersonControls } from '@/components/people/person-controls';
import { Badge, Card, ENROLLMENT_TONE, enrollmentStatusLabel, KeyValue, PageHeader, personStage, Tabs } from '@/components/ui';

type TimelineItem = { at: Date; kind: 'touch' | 'note' | 'task' | 'state'; icon: string; title: string; detail?: string | null; tone?: 'in' | 'out' | 'neutral' };

export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { tab = 'activity' } = await searchParams;
  let person = await prisma.personCache.findUnique({ where: { id } });
  // Instant sync: re-read this person from Twenty on every visit so CRM edits show immediately,
  // even between webhooks. Failures fall back to the cache.
  let liveWarning: string | null = null;
  try {
    const client = await getTwentyClient();
    const fresh = await client.getPerson(id);
    if (fresh) {
      await upsertPersonCache(fresh);
      person = await prisma.personCache.findUnique({ where: { id } });
    }
  } catch (err) {
    liveWarning = `Showing cached data; Twenty unavailable (${err instanceof Error ? err.message : String(err)}).`;
  }
  if (!person) notFound();
  const actor = toActor(user);

  const [enrollments, touches, tasks, audit, conn, pods, sequences, colleagues] = await Promise.all([
    prisma.enrollment.findMany({
      where: { personId: id },
      include: { fo: { select: { id: true, name: true } }, sequence: { include: { activeVersion: true } }, sequenceVersion: true, campaign: { select: { id: true, name: true } }, pod: { include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.touch.findMany({ where: { personId: id }, orderBy: { occurredAt: 'desc' }, take: 100 }),
    prisma.task.findMany({ where: { enrollment: { personId: id } }, include: { fo: { select: { name: true } } }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }] }),
    prisma.auditLog.findMany({ where: { OR: [{ entityType: 'person', entityId: id }, { entityType: 'enrollment', entityId: { in: (await prisma.enrollment.findMany({ where: { personId: id }, select: { id: true } })).map((e) => e.id) } }] }, orderBy: { createdAt: 'desc' }, take: 100 }),
    getTwentyConnection(),
    prisma.pod.findMany({ include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } }, orderBy: { name: 'asc' } }),
    prisma.sequence.findMany({ where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    person.companyId ? prisma.personCache.findMany({ where: { companyId: person.companyId, id: { not: id }, deletedAt: null }, include: { enrollments: { orderBy: { createdAt: 'desc' }, take: 1 } }, take: 30 }) : Promise.resolve([]),
  ]);

  let notes: TwentyNote[] = [];
  let opportunities: TwentyOpportunity[] = [];
  let twentyWarning: string | null = null;
  try {
    const client = await getTwentyClient();
    [notes, opportunities] = await Promise.all([client.listNotes({ personId: id, limit: 20 }).then((p) => p.items), client.listOpportunities({ personId: id }).then((p) => p.items)]);
  } catch (err) {
    twentyWarning = `Twenty unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

  const latest = enrollments[0] ?? null;
  const active = enrollments.find((e) => e.status === 'ACTIVE' || e.status === 'PAUSED') ?? null;
  const stage = personStage(person, latest);
  const twentyUrl = twentyPersonUrl(conn.baseUrl, id);
  const visible = visiblePodIds(user);
  const enrolPods = pods.filter((p) => visible === null || visible.includes(p.id)).map((p) => ({ id: p.id, name: p.name, podOwnerValue: p.podOwnerValue, fos: p.users.filter((u) => u.user.active).map((u) => ({ id: u.user.id, name: u.user.name })) }));
  const activeSteps = active?.sequence.activeVersion ? parseSteps(active.sequence.activeVersion.steps) : [];

  // Unified timeline
  const items: TimelineItem[] = [
    ...touches.map<TimelineItem>((t) => ({ at: t.occurredAt, kind: 'touch', icon: t.channel, title: t.summary, detail: t.actorLabel, tone: t.direction === 'INBOUND' ? 'in' : 'out' })),
    ...notes
      .filter((n) => !touches.some((t) => t.externalId.startsWith(`note:${n.id}:`)))
      .map<TimelineItem>((n) => ({ at: new Date(n.createdAt), kind: 'note', icon: 'NOTE', title: n.title, detail: n.bodyMarkdown ?? n.createdByName, tone: 'neutral' })),
    ...tasks
      .filter((t) => t.state === 'SKIPPED' || (t.state === 'DONE' && !touches.some((x) => x.externalId === `task:${t.id}` || x.externalId === t.evidenceId)))
      .map<TimelineItem>((t) => ({ at: t.completedAt ?? t.updatedAt, kind: 'task', icon: t.action, title: `${t.label} ${t.state === 'DONE' ? 'done' : 'skipped'}${t.disposition ? ` - ${t.disposition}` : ''}${t.skipReason ? `: ${t.skipReason}` : ''}`, detail: t.note ?? t.fo.name, tone: 'out' })),
    ...audit
      .filter((a) => ['enrolled', 'replied', 'meeting', 'exited', 'completed', 'paused', 'resumed', 'finished', 'moved_to_step', 'flags_updated', 'reassigned'].includes(a.action))
      .map<TimelineItem>((a) => ({ at: a.createdAt, kind: 'state', icon: 'STATE', title: `${a.action.replace(/_/g, ' ')}${a.actorLabel ? ` by ${a.actorLabel}` : ''}`, detail: a.details ? JSON.stringify(a.details).slice(0, 160) : null, tone: 'neutral' })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const tabs = [
    { key: 'activity', label: 'Activity', count: items.length },
    { key: 'sequences', label: 'Sequences', count: enrollments.length },
    { key: 'details', label: 'Details' },
  ];

  return (
    <>
      <PageHeader
        title={cachedPersonName(person)}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={stage.tone}>{stage.label}</Badge>
            {person.dnd ? <Badge tone="red">DND in Twenty</Badge> : null}
            {person.optedOut ? <Badge tone="red">Opted out</Badge> : null}
            {person.badEmail ? <Badge tone="amber">bad email</Badge> : null}
            {person.badPhone ? <Badge tone="amber">bad phone</Badge> : null}
            <span>
              {person.jobTitle ?? 'Unknown title'}
              {person.companyName ? ` · ${person.companyName}` : ''}
              {person.podOwner ? ` · Pod ${person.podOwner}` : ''}
            </span>
          </span>
        }
        actions={
          <>
            {person.email ? (
              <a href={`mailto:${person.email}`} className="btn-secondary">
                <ActionIcon action="EMAIL" size={14} /> Email
              </a>
            ) : null}
            {person.phone ? (
              <a href={`tel:${person.phone}`} className="btn-secondary">
                <ActionIcon action="CALL" size={14} /> Call
              </a>
            ) : null}
            {person.linkedinUrl ? (
              <a href={person.linkedinUrl} target="_blank" rel="noreferrer" className="btn-secondary">
                <ActionIcon action="LINKEDIN_MESSAGE" size={14} /> LinkedIn
              </a>
            ) : null}
            {twentyUrl ? (
              <a href={twentyUrl} target="_blank" rel="noreferrer" className="btn-secondary">
                <IconExternal size={14} /> Open in Twenty
              </a>
            ) : null}
            <Link href="/people" className="btn-ghost">
              All people
            </Link>
          </>
        }
      />
      <div className="grid gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          <Tabs current={tab} tabs={tabs.map((t) => ({ ...t, href: `/people/${id}?tab=${t.key}` }))} />
          <div className="pt-4">
            {tab === 'activity' ? (
              <Card title="Activity">
                {twentyWarning ?? liveWarning ? <div className="px-4 pt-3 text-xs text-amber-700">{twentyWarning ?? liveWarning}</div> : null}
                {items.length === 0 ? (
                  <div className="p-4 text-sm text-slate-500">No activity yet.</div>
                ) : (
                  <ol className="divide-y divide-slate-100">
                    {items.map((it, i) => (
                      <li key={i} className="flex gap-3 px-4 py-2.5 text-sm">
                        <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : it.tone === 'out' ? 'mt-0.5 text-slate-500' : 'mt-0.5 text-slate-400'}>
                          {it.icon === 'NOTE' || it.icon === 'STATE' ? <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" /> : <ActionIcon action={it.icon} size={14} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-slate-800">{it.title}</span>
                          {it.detail ? <span className="block truncate text-xs text-slate-500">{it.detail}</span> : null}
                        </span>
                        <span className="shrink-0 text-xs text-slate-400">{formatInstant(it.at, user.timezone)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            ) : null}

            {tab === 'sequences' ? (
              <div className="space-y-4">
                {enrollments.length === 0 ? <Card><div className="p-4 text-sm text-slate-500">Never enrolled.</div></Card> : null}
                {enrollments.map((e) => {
                  const steps = parseSteps(e.sequenceVersion.steps);
                  const eTasks = tasks.filter((t) => t.enrollmentId === e.id);
                  return (
                    <Card
                      key={e.id}
                      title={
                        <>
                          <Link href={`/sequences/${e.sequenceId}`} className="hover:underline">
                            {e.sequence.name}
                          </Link>{' '}
                          v{e.sequenceVersion.version} <Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'} className="ml-1">{enrollmentStatusLabel(e)}</Badge>
                          <span className="ml-2 text-xs font-normal text-slate-500">
                            {e.fo.name} · started {formatLocalDate(e.startDate, 'long')}
                            {e.campaign ? ` · ${e.campaign.name}` : ''}
                            {e.shiftDays ? ` · shifted ${e.shiftDays}d` : ''}
                          </span>
                        </>
                      }
                    >
                      <ol className="divide-y divide-slate-100">
                        {steps.map((step, i) => {
                          const st = eTasks.filter((t) => t.stepIndex === i);
                          const reached = st.length > 0;
                          return (
                            <li key={step.id} className={`flex items-center gap-3 px-4 py-2 text-sm ${reached ? '' : 'opacity-50'}`}>
                              <span className="w-14 shrink-0 text-xs font-semibold uppercase text-slate-500">Day {step.day}</span>
                              <span className="flex-1 text-slate-800">{describeStep(step)}</span>
                              <span className="flex flex-wrap gap-1">
                                {st.map((t) => (
                                  <Badge key={t.id} tone={t.state === 'DONE' ? 'green' : t.state === 'PENDING' ? 'blue' : t.state === 'SKIPPED' ? 'amber' : 'gray'}>
                                    {t.label}: {t.state === 'PENDING' ? `due ${t.snoozedTo ?? t.dueDate}` : t.state.toLowerCase()}
                                    {t.disposition ? ` (${t.disposition})` : ''}
                                  </Badge>
                                ))}
                                {!reached ? <span className="text-xs text-slate-400">not reached</span> : null}
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    </Card>
                  );
                })}
              </div>
            ) : null}

            {tab === 'details' ? (
              <Card title="Details from Twenty">
                <div className="p-4">
                  <KeyValue
                    items={[
                      { k: 'Email', v: person.email },
                      { k: 'Phone', v: person.phone },
                      { k: 'LinkedIn', v: person.linkedinUrl },
                      { k: 'Title', v: person.jobTitle },
                      { k: 'Company', v: person.companyName },
                      { k: 'City', v: person.city },
                      { k: 'Where we met', v: person.eventSource },
                      { k: 'Pod owner', v: person.podOwner },
                      { k: 'Tags', v: person.tags.join(', ') || null },
                      { k: 'Meeting status', v: person.statusOfMeeting },
                      { k: 'Twenty id', v: <span className="font-mono text-xs">{person.id}</span> },
                      { k: 'Last synced', v: formatInstant(person.syncedAt, user.timezone) },
                    ]}
                  />
                </div>
              </Card>
            ) : null}
          </div>
        </div>

        <aside className="space-y-4">
          <PersonControls
            personId={id}
            optedOut={person.optedOut}
            badEmail={person.badEmail}
            badPhone={person.badPhone}
            dnd={person.dnd}
            canManagePerson={canEnroll(actor)}
            active={active ? { id: active.id, status: active.status, foUserId: active.foUserId, currentStep: active.currentStep, canManage: canManageEnrollment(actor, active) } : null}
            steps={activeSteps.map((s, index) => ({ index, label: `Day ${s.day} · ${describeStep(s)}` }))}
            fos={active?.pod?.users.filter((u) => u.user.active).map((u) => ({ id: u.user.id, name: u.user.name })) ?? []}
            sequences={sequences}
            pods={enrolPods}
            defaultPodId={person.podOwner ? pods.find((p) => p.podOwnerValue === person.podOwner)?.id ?? null : null}
          />
          <Card title="Open opportunities">
            {opportunities.length === 0 ? (
              <div className="p-4 text-sm text-slate-500">None.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {opportunities.map((o) => (
                  <li key={o.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>{o.name}</span>
                    <Badge tone="purple">{o.stage ?? 'open'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Colleagues at ${person.companyName ?? 'company'}`}>
            {colleagues.length === 0 ? (
              <div className="p-4 text-sm text-slate-500">Nobody else known here.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {colleagues.map((c) => {
                  const st = personStage(c, c.enrollments[0] ?? null);
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                      <Link href={`/people/${c.id}`} className="min-w-0 truncate text-slate-800 hover:underline">
                        {cachedPersonName(c)}
                        {c.jobTitle ? <span className="text-slate-500"> · {c.jobTitle}</span> : null}
                      </Link>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
