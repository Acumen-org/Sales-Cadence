import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { canAssignSandbox, canEraseContact, canMoveToCrm, canWorkSandboxContact, isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate, toLocalDate, todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { assignableOwners } from '@/lib/outreach/ownership';
import { workWords } from '@/lib/outreach/transfer';
import { latestMoves } from '@/lib/sandbox/moves-query';
import { UndoMoveButton } from '@/components/sandbox/move-undo';
import { getSettings } from '@/lib/settings';
import { checkReady, moveSignals } from '@/lib/sandbox/ready';
import { callGate } from '@/lib/calls/gate';
import { canAct, loadColdSubject } from '@/lib/outreach/guard';
import { callOutcomes } from '@/lib/engine/outcomes';
import { NEXT_STEP_LABELS } from '@/lib/sandbox/history-notes';
import { PRODUCT_VALUES } from '@/lib/sandbox/bellwether-api';
import { readExtraPhones } from '@/lib/sandbox/normalize';
import { ActionForm } from '@/components/action-form';
import { Badge, EmptyState, Notice, Surface, ViewHeader, enrollmentStatusLabel } from '@/components/ui';
import { CallButton } from '@/components/calls/call-button';
import { LogCallButton } from '@/components/calls/log-call';
import { SuggestionList } from '@/components/calls/suggestions';
import { openSuggestions } from '@/lib/outreach/suggestions';
import { openCallItems } from '@/lib/calls/link';
import { pendingFormBlock } from '@/lib/calls/gate';
import { mayHearCall } from '@/lib/calls/access';
import { formOptOut } from '@/lib/tickets';
import { FormOptOutControls } from '@/components/tickets/close-ticket-form';
import { ContactActions } from '@/components/sandbox/contact-actions';
import { addNoteAction, setNextActionAction, setPodAction, updateContactAction } from '@/lib/actions/sandbox';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { eraseConfirm, optOutConfirm, removeConfirm } from '@/lib/outreach/confirm-words';
import { coldRef } from '@/lib/subject';

const STATUS_LABEL = { ACTIVE: 'In Cold outreach', MOVED: 'In CRM', OPTED_OUT: 'Do not contact', REMOVED: 'Removed' } as const;

/** Audit actions the contact's history shows (B108). */
const HISTORY_ACTIONS = ['claimed', 'assigned', 'released', 'reassigned', 'pod_set', 'move_queued', 'sandbox_moved', 'move_failed', 'move_undone', 'opted_out', 'opt_out_lifted', 'removed'] as const;

function historyWords(action: string, d: Record<string, unknown> | null, names: Map<string, string>): string {
  const to = typeof d?.to === 'string' ? names.get(d.to) ?? 'someone' : null;
  switch (action) {
    case 'claimed': return 'Claimed';
    case 'assigned': return `Given to ${to ?? 'someone'}`;
    case 'reassigned': return `Handed to ${to ?? 'someone'}${d?.reason === 'team_access_removed' ? ' when its owner left' : d?.reason === 'pod_change' ? ' with a pod change' : ''}`;
    case 'released': return 'Let go';
    case 'pod_set': return 'Pod changed';
    case 'move_queued': return 'Queued to move to the CRM';
    case 'sandbox_moved': return 'Moved to the CRM';
    case 'move_failed': return `Move failed${typeof d?.reason === 'string' ? `: ${d.reason}` : ''}`;
    case 'move_undone': return 'Move to the CRM undone';
    case 'opted_out': return 'Opted out';
    case 'opt_out_lifted': return 'Opt-out lifted';
    case 'removed': return 'Removed';
    default: return action.replace(/_/g, ' ');
  }
}

/** One sandbox contact: what we know, what happened, and what happens next. Sandbox data is edited in place. */
export default async function SandboxContactPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ move?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const openMove = (await searchParams).move === '1';
  const contact = await prisma.sandboxContact.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, twentyMemberId: true, active: true } }, pod: { select: { id: true, name: true } },
      notes: { orderBy: { createdAt: 'desc' } }, emails: { orderBy: { at: 'desc' } },
      calls: { orderBy: { startedAt: 'desc' }, include: { form: true, user: { select: { name: true } } } },
      nextActions: { where: { state: 'OPEN' }, include: { fo: { select: { name: true } } }, take: 1 },
      enrollments: { orderBy: { createdAt: 'desc' }, include: { campaign: { select: { id: true, name: true } }, sequence: { select: { name: true } }, tasks: { orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }], select: { id: true, label: true, state: true, dueDate: true, completedAt: true } } } },
    },
  });
  if (!contact) notFound();
  const actor = toActor(user);
  // B119, B208: Assign offers only the reps this reader may give the contact to.
  const [settings, users, moves, signals, history, pods] = await Promise.all([
    getSettings(), assignableOwners(user), latestMoves([contact.id], actor), moveSignals([contact.id]),
    prisma.auditLog.findMany({ where: { entityType: 'sandbox_contact', entityId: contact.id, action: { in: [...HISTORY_ACTIONS] } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.pod.findMany({ where: { archived: false, ...(isAdmin(user) ? {} : { id: { in: user.podIds } }) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const move = moves.get(contact.id) ?? null;
  // B050: the pod picker, for a contact with no pod or an owner in several pods: their pods, else the reader's.
  const ownerPodIds = contact.ownerId && contact.owner?.active ? (await prisma.userPod.findMany({ where: { userId: contact.ownerId, pod: { archived: false } }, select: { podId: true } })).map((p) => p.podId) : null;
  const podChoices = contact.status === 'ACTIVE' && canWorkSandboxContact(actor, contact) ? pods.filter((p) => !ownerPodIds || ownerPodIds.includes(p.id)) : [];
  const signal = signals.get(contact.id) ?? null;
  const live = contact.status === 'ACTIVE';
  const mayWork = live && canWorkSandboxContact(actor, contact);
  const ready = checkReady(contact, { owner: contact.owner, podName: contact.pod?.name ?? null, settings: settings.sandbox });
  // D3: complete details are the hard rule; green "Ready to move" also needs a positive outcome (B155).
  const readyToMove = ready.ready && Boolean(signal?.positive);
  const runningCampaigns = contact.enrollments.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED');
  const work = workWords({ nextSteps: contact.nextActions.filter((n) => !n.personId).length, enrollments: runningCampaigns.length, tasks: runningCampaigns.reduce((k, e) => k + e.tasks.filter((t) => t.state === 'PENDING').length, 0) });
  const actorNames = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(history.flatMap((h) => [h.actorId, (h.details as { to?: string } | null)?.to].filter((x): x is string => Boolean(x))))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const gate = contact.phone && live ? await callGate(user, contact) : null;
  // B120: the Call button says why when this viewer may not work the contact. N027: a removed
  // contact can still be opted out (any sales user) and erased (admins).
  const subject = await loadColdSubject(contact.id);
  const callVerdict = subject ? canAct(actor, subject, 'call') : null;
  const callBlocked = callVerdict && !callVerdict.ok ? callVerdict.reason : gate?.blocked ?? null;
  const mayOptOut = Boolean(subject && canAct(actor, subject, 'opt_out').ok);
  const outcomes = callOutcomes(settings.rules);
  const today = todayIn(user.timezone);
  const name = `${contact.firstName} ${contact.lastName}`.trim() || 'Removed contact';
  const open = contact.nextActions[0];
  // D4: an opt-out from the post-call form can be questioned by anyone and undone by an admin.
  const formOpt = contact.status === 'OPTED_OUT' && !contact.piiClearedAt ? await formOptOut(coldRef(contact.id)) : null;
  // B024, B027: Log a call with the steps it could close; colleagues' suggested steps for this owner.
  const [callSteps, logBlocked, suggestions] = await Promise.all([
    mayWork ? openCallItems({ personId: null, sandboxContactId: contact.id }, null) : Promise.resolve([]),
    mayWork ? pendingFormBlock(user.id, user.timezone) : Promise.resolve(null),
    openSuggestions(user.id, { sandboxContactId: contact.id }),
  ]);
  const nowLocal = new Intl.DateTimeFormat('sv-SE', { timeZone: user.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
  // Opt out, Remove and Erase name the person and every effect (PLAN 4.0), and ask why.
  const effects = { name, campaigns: runningCampaigns.map((e) => e.campaign?.name ?? e.sequence.name), nextStep: open && !open.personId ? `${ACTION_LABELS[open.action]} on ${formatLocalDate(open.dueDate)}` : null, fromBellwether: contact.source === 'BELLWETHER', inCrm: contact.status === 'MOVED' };
  const confirms = { optOut: optOutConfirm(effects), remove: removeConfirm(effects), erase: eraseConfirm(effects) };
  // N051: a call's notes and recording show only to its rep, the owner and those who see Reports.
  const hears = (c: (typeof contact.calls)[number]) => mayHearCall(actor, { userId: c.userId, formUserId: c.formUserId, ownerId: contact.ownerId });
  const timeline = [
    ...contact.calls.filter((c) => !c.discardedAt).map((c) => ({ at: c.startedAt ?? c.createdAt, key: `c${c.id}`, node: <div><Link href={`/calls/${c.id}`} className="text-ink-900 hover:text-brand-700">{c.direction === 'OUTBOUND' ? 'Call' : 'Call received'}{c.talkSec ? ` · ${Math.floor(c.talkSec / 60)}m ${c.talkSec % 60}s` : ''}</Link><span className="text-ink-500"> · {c.user?.name ?? 'Unknown rep'}{c.form ? ` · ${outcomes.find((o) => o.key === c.form!.outcome)?.label ?? c.form.outcome}${c.form.rating ? ` (${c.form.rating}/5)` : ''}` : c.formDueAt ? ' · form due' : ''}</span>{c.form?.notes && hears(c) ? <p className="mt-1 whitespace-pre-wrap text-ink-700">{c.form.notes}</p> : null}{c.form ? <p className="text-ink-500">Next: {c.form.nextStepLabel ?? NEXT_STEP_LABELS[c.form.nextStep] ?? c.form.nextStep}{c.form.nextStepDate ? `, ${formatLocalDate(c.form.nextStepDate)}` : ''}</p> : null}{c.recordingSid && hears(c) ? <audio controls preload="none" className="mt-1 h-8" src={`/api/calls/${c.id}/recording`} /> : null}</div> })),
    ...contact.emails.map((m) => ({ at: m.at, key: `m${m.id}`, node: <div><span className="text-ink-900">{m.kind === 'SENT' ? 'Email sent' : m.kind === 'REPLY' ? 'Reply' : m.kind === 'BOUNCE' ? 'Bounced' : 'Auto-reply'}</span><span className="text-ink-500"> · {m.subject ?? '(no subject)'}</span></div> })),
    ...contact.notes.map((n) => ({ at: n.createdAt, key: `n${n.id}`, node: <div><span className="text-ink-900">Note</span><span className="text-ink-500"> · {n.authorName ?? 'Cadence'}</span><p className="mt-1 whitespace-pre-wrap text-ink-700">{n.body}</p></div> })),
    ...contact.enrollments.flatMap((e) => e.tasks.filter((t) => t.state === 'DONE' && t.completedAt).map((t) => ({ at: t.completedAt!, key: `t${t.id}`, node: <div><span className="text-ink-900">{t.label} done</span><span className="text-ink-500"> · {e.campaign?.name ?? e.sequence.name}</span></div> }))),
    // B108: claims, hand-overs, moves and undos are in the history too.
    ...history.map((h) => ({ at: h.createdAt, key: `a${h.id}`, node: <div><span className="text-ink-900">{historyWords(h.action, h.details as Record<string, unknown> | null, actorNames)}</span><span className="text-ink-500"> · {h.actorLabel ?? 'Cadence'}</span></div> })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const input = (label: string, field: string, value: string | null | undefined, type = 'text') => <label className="block text-xs text-ink-500">{label}<input name={field} type={type} defaultValue={value ?? ''} disabled={!mayWork} className="mt-1 w-full" /></label>;

  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <Surface>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[12px] text-ink-500"><Link href="/sandbox" className="hover:text-ink-700">Cold outreach</Link></div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{name}</h1>
          <div className="mt-1 text-sm text-ink-600">{[contact.jobTitle, contact.companyName].filter(Boolean).join(' · ') || 'No title or firm yet'}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={live ? 'green' : 'gray'}>{STATUS_LABEL[contact.status]}</Badge>
            {live && move && (move.state === 'QUEUED' || move.state === 'RUNNING') ? <Badge tone="blue">Moving to CRM…</Badge> : null}
            {live && !contact.crmMatchPersonId && !contact.crmAutoPersonId ? (signal?.closed ? <Badge tone="gray">{`Closed · ${signal.closed.outcome}${signal.closed.at ? ` · ${formatLocalDate(toLocalDate(signal.closed.at, workspaceTimezone()), 'year')}` : ''}`}</Badge> : <Badge tone={readyToMove ? 'green' : ready.ready ? 'blue' : 'amber'}>{readyToMove ? 'Ready to move' : ready.ready ? 'CRM details complete' : `Needs ${ready.missing.map((m) => m.text.toLowerCase()).join(', ')}`}</Badge>) : null}
            <span className="text-ink-600">{contact.owner ? `${contact.owner.name}${contact.owner.active ? '' : ' (removed)'}` : 'Unclaimed'}{contact.pod ? ` · ${contact.pod.name}` : ''}</span>
            {podChoices.length > 1 || (mayWork && !contact.podId && podChoices.length) ? <ActionForm action={setPodAction} className="flex items-center gap-1.5"><input type="hidden" name="id" value={contact.id} /><select name="podId" aria-label="Pod" defaultValue={contact.podId ?? ''} className="!py-0.5 text-[12px]"><option value="" disabled>Choose its pod</option>{podChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button type="submit" className="btn-ghost btn-sm">Set pod</button></ActionForm> : null}
            {contact.status === 'MOVED' && contact.twentyPersonId ? <Link href={`/people/${contact.twentyPersonId}`} className="text-brand-700 hover:underline">Open in People</Link> : null}
            {contact.status !== 'MOVED' && contact.crmAutoPersonId ? <Link href={`/people/${contact.crmAutoPersonId}`} className="hover:underline"><Badge tone="amber">{`Also in CRM, created from ${contact.crmAutoSource === 'CALENDAR' ? 'calendar' : 'email'}`}</Badge></Link> : null}
            {live && contact.crmMatchPersonId && contact.crmMatchPersonId !== contact.crmAutoPersonId ? <Link href={`/people/${contact.crmMatchPersonId}`} className="hover:underline"><Badge tone="amber">Also in CRM</Badge></Link> : null}
          </div>
          {live && ready.ready && (ready.warnings.length || signal?.positive) ? <div className="mt-2 text-[12px] text-ink-600">{[signal?.positive ? `Positive outcome: ${signal.positive}` : 'No conversation yet', ...ready.warnings.map((w) => w.text)].join(' · ')}</div> : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          {contact.phone && live ? <CallButton phone={contact.phone} template={settings.rules.clickToCallUrl} sandboxContactId={contact.id} nextActionId={open?.id ?? null} blocked={callBlocked} warning={gate?.warning} /> : null}
          {mayWork ? <LogCallButton sandboxContactId={contact.id} name={name} steps={callSteps.map((s) => ({ key: `${s.kind}:${s.id}`, words: s.words }))} now={nowLocal} blocked={logBlocked} /> : null}
          {live ? <ContactActions id={contact.id} name={name} ready={readyToMove} unclaimed={!contact.ownerId || !contact.owner?.active} mayWork={mayWork} mayOptOut={mayOptOut} mayMove={canMoveToCrm(actor, contact)} mayAssign={users.length > 0 && canAssignSandbox(actor, contact, null) && (isAdmin(user) || actor.role !== 'JUNIOR_FO')} mayErase={canEraseContact(actor)} users={users} ownerId={contact.ownerId} work={work} pods={pods} confirms={confirms} openMove={openMove} /> : contact.status === 'REMOVED' || (contact.status === 'OPTED_OUT' && !contact.piiClearedAt) ? <ContactActions id={contact.id} ready={false} unclaimed={false} mayWork={false} mayOptOut={contact.status === 'REMOVED' && mayOptOut} mayMove={false} mayAssign={false} mayErase={canEraseContact(actor)} users={[]} confirms={confirms} /> : null}
        </div>
      </div>
    </Surface>
    {contact.status === 'MOVED' ? <Notice tone="success"><span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>Moved to the CRM{move?.moverName ? ` by ${move.moverName}` : ''}{contact.movedAt ? ` on ${formatLocalDate(toLocalDate(contact.movedAt, workspaceTimezone()), 'year')}` : ''}{move?.mode === 'attach' && move.personName ? `, as history on ${move.personName}` : ''}.</span>
      {contact.twentyPersonId ? <Link href={`/people/${contact.twentyPersonId}`} className="underline">Open in People</Link> : null}
      {move?.undoUntil ? <span>Undo until {move.undoUntil}</span> : null}
      {move?.canUndo ? <UndoMoveButton itemIds={[move.itemId]} confirm={move.undoConfirm} campaigns={move.campaigns} /> : null}
    </span></Notice> : null}
    {formOpt ? <Notice tone="error"><span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      <span><span className="font-medium">Do not contact</span> since {formOpt.at ? formatInstant(formOpt.at, user.timezone) : 'the call'}: {formOpt.byName ?? 'a rep'} chose &quot;Asked not to be contacted&quot; on the post-call form{formOpt.callId ? <> (<Link href={`/calls/${formOpt.callId}`} className="underline">the call</Link>)</> : null}. Do not email, call or message this person.{formOpt.lastTicket?.outcome === 'kept' ? ` Biz Ops checked it: ${formOpt.lastTicket.resolution ?? 'it stays'}.` : ''}</span>
      <FormOptOutControls subject={{ sandboxContactId: contact.id }} name={name} mayLift={isAdmin(user)} ticket={formOpt.ticket ? `Biz Ops are looking at it: raised by ${formOpt.ticket.raisedBy ?? 'someone'} ${formatInstant(formOpt.ticket.raisedAt, user.timezone)}.` : null} />
    </span></Notice> : null}
    {live && move?.state === 'FAILED' ? <Notice tone="error">Move failed: {move.error ?? 'see the move'} <Link href={`/sandbox/moves/${move.moveId}`} className="underline">{move.failure === 'permanent' ? 'See the move' : 'Retry'}</Link></Notice> : null}
    {live && contact.owner && !contact.owner.active ? <Notice tone="warn">{contact.owner.name} has left: this contact needs a new owner before it can move or be worked by its pod&apos;s reps.</Notice> : null}
    <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
      <div className="space-y-4">
        <Surface flush>
          <ViewHeader title="Activity" />
          {timeline.length ? <ol className="divide-y divide-line">{timeline.map((item) => <li key={item.key} className="flex gap-4 px-4 py-3 text-[13px]"><time className="w-28 shrink-0 tabular-nums text-ink-500">{formatInstant(item.at, user.timezone)}</time><div className="min-w-0 flex-1">{item.node}</div></li>)}</ol> : <EmptyState title="Nothing has happened yet" />}
        </Surface>
        <Surface flush>
          <ViewHeader title="Campaigns" />
          {contact.enrollments.length ? <ul className="divide-y divide-line text-[13px]">{contact.enrollments.map((e) => <li key={e.id} className="px-4 py-2.5"><Link href={e.campaign ? `/sandbox/campaigns/${e.campaign.id}` : '#'} className="text-ink-900 hover:text-brand-700">{e.campaign?.name ?? e.sequence.name}</Link><span className="text-ink-500"> · {enrollmentStatusLabel(e)}</span><div className="mt-1 flex flex-wrap gap-1.5">{e.tasks.map((t) => <span key={t.id} className={t.state === 'DONE' ? 'text-brand-700' : t.state === 'PENDING' ? 'text-ink-900' : 'text-ink-400'}>{t.label}{t.state === 'PENDING' ? ` (${formatLocalDate(t.dueDate)})` : ''}</span>)}</div></li>)}</ul> : <EmptyState title="Not in a campaign" />}
        </Surface>
      </div>
      <div className="space-y-4">
        <Surface flush>
          <ViewHeader title="Next action" />
          <div className="space-y-3 p-4 text-[13px]">
            {open ? <div className="text-ink-900">{open.label} · {open.kind === 'MEETING' ? 'Meeting' : ACTION_LABELS[open.action]} · {formatLocalDate(open.dueDate, 'long')}{open.meetingAt ? ` at ${new Intl.DateTimeFormat('en-GB', { timeZone: user.timezone, hour: '2-digit', minute: '2-digit' }).format(open.meetingAt)}` : ''} <span className="text-ink-500">· {open.fo.name}</span></div> : <div className="text-ink-500">None set</div>}
            <SuggestionList items={live ? suggestions.map((s) => ({ id: s.id, from: s.from, words: s.words })) : []} />
            {live && contact.crmMatchPersonId ? <p className="text-ink-600">Outreach stopped: this person was added to the CRM after the push. Move to CRM attaches this history to them.</p> : null}
            {mayWork && !contact.crmMatchPersonId ? <ActionForm action={setNextActionAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={contact.id} />
              <label className="block text-xs text-ink-500">What<input name="label" required defaultValue={open?.label ?? ''} className="mt-1 w-40" /></label>
              <label className="block text-xs text-ink-500">How<select name="action" defaultValue={open?.action ?? 'CALL'} className="mt-1"><option value="CALL">Call</option><option value="EMAIL">Email</option><option value="LINKEDIN_MESSAGE">LinkedIn message</option><option value="LINKEDIN_CONNECT">LinkedIn connect</option></select></label>
              <label className="block text-xs text-ink-500">When<input type="date" name="dueDate" required min={today} defaultValue={open?.dueDate ?? today} className="mt-1" /></label>
              <button type="submit" className="btn-secondary btn-sm">Set</button>
            </ActionForm> : null}
          </div>
        </Surface>
        <Surface flush>
          <ViewHeader title="Details" />
          <ActionForm action={updateContactAction} className="space-y-4 p-4">
            <input type="hidden" name="id" value={contact.id} />
            <div className="grid grid-cols-2 gap-3">
              {input('First name', 'firstName', contact.firstName)}{input('Last name', 'lastName', contact.lastName)}
              {input('Job title', 'jobTitle', contact.jobTitle)}{input('Email', 'email', contact.email, 'email')}
              {input('Phone', 'phone', contact.phone)}
              <label className="block text-xs text-ink-500">Phone type<select name="phoneType" defaultValue={contact.phoneType ?? 'unknown'} disabled={!mayWork} className="mt-1 w-full"><option value="direct">Direct</option><option value="mobile">Mobile</option><option value="office">Office</option><option value="main">Main line</option><option value="toll_free">Toll free</option><option value="unknown">Unknown</option></select></label>
              {input('LinkedIn', 'linkedinUrl', contact.linkedinUrl ? `https://www.${contact.linkedinUrl}` : null)}{input('City', 'city', contact.city)}
              {input('State', 'state', contact.state)}{input('Country', 'country', contact.country)}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {input('Firm', 'companyName', contact.companyName)}{input('Firm website', 'companyWebsite', contact.companyWebsite ?? contact.companyDomain)}
              {input('Firm CRD', 'companyCrd', contact.companyCrd)}{input('Individual CRD', 'individualCrd', contact.individualCrd)}
            </div>
            <fieldset className="text-xs text-ink-500"><legend>Product interest</legend><div className="mt-1 flex flex-wrap gap-3">{PRODUCT_VALUES.map((p) => <label key={p} className="inline-flex items-center gap-1 text-[13px] text-ink-700"><input type="checkbox" name="productInterest" value={p} defaultChecked={contact.productInterest.includes(p)} disabled={!mayWork} />{p}</label>)}</div></fieldset>
            {readExtraPhones(contact.additionalPhones).length ? <div className="text-[13px] text-ink-600">Other phones: {readExtraPhones(contact.additionalPhones).map((p) => `${p.number} (${p.type.replace('_', ' ')})`).join(', ')}</div> : null}
            <div className="text-[13px] text-ink-500">{contact.source === 'BELLWETHER' ? 'From Bellwether' : contact.source === 'MANUAL' ? 'Added in Cadence' : 'From a call'}{contact.sourceNote ? ` · ${contact.sourceNote}` : ''}{contact.pushedByEmail ? ` · pushed by ${contact.pushedByEmail}` : ''}{contact.bellwetherUrl ? <> · <a href={contact.bellwetherUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Bellwether</a></> : null}</div>
            {mayWork ? <div className="flex justify-end"><button type="submit" className="btn-secondary btn-sm">Save</button></div> : null}
          </ActionForm>
        </Surface>
        <Surface flush>
          <ViewHeader title="Notes" />
          {mayWork ? <ActionForm action={addNoteAction} resetOnSuccess className="space-y-2 p-4"><input type="hidden" name="id" value={contact.id} /><textarea name="body" rows={3} aria-label="Note" className="w-full" required /><div className="flex justify-end"><button type="submit" className="btn-secondary btn-sm">Add note</button></div></ActionForm> : null}
        </Surface>
      </div>
    </div>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
