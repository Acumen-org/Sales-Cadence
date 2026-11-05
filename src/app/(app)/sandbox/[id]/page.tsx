import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { canAssignSandbox, canEraseContact, canMoveToCrm, canWorkSandboxContact, isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate, todayIn } from '@/lib/dates';
import { getSettings } from '@/lib/settings';
import { checkReady } from '@/lib/sandbox/ready';
import { callGate } from '@/lib/calls/gate';
import { canAct, loadColdSubject } from '@/lib/outreach/guard';
import { callOutcomes } from '@/lib/engine/outcomes';
import { NEXT_STEP_LABELS } from '@/lib/sandbox/history-notes';
import { PRODUCT_VALUES } from '@/lib/sandbox/bellwether-api';
import { readExtraPhones } from '@/lib/sandbox/normalize';
import { ActionForm } from '@/components/action-form';
import { Badge, EmptyState, Surface, ViewHeader } from '@/components/ui';
import { CallButton } from '@/components/calls/call-button';
import { ContactActions } from '@/components/sandbox/contact-actions';
import { addNoteAction, setNextActionAction, updateContactAction } from '@/lib/actions/sandbox';
import { ACTION_LABELS } from '@/lib/sequences/steps';

const STATUS_LABEL = { ACTIVE: 'In the sandbox', MOVED: 'Moved to the CRM', OPTED_OUT: 'Opted out', REMOVED: 'Removed' } as const;

/** One sandbox contact: what we know, what happened, and what happens next. Sandbox data is edited in place. */
export default async function SandboxContactPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const contact = await prisma.sandboxContact.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, twentyMemberId: true } }, pod: { select: { id: true, name: true } },
      notes: { orderBy: { createdAt: 'desc' } }, emails: { orderBy: { at: 'desc' } },
      calls: { orderBy: { startedAt: 'desc' }, include: { form: true, user: { select: { name: true } } } },
      nextActions: { where: { state: 'OPEN' }, include: { fo: { select: { name: true } } }, take: 1 },
      enrollments: { orderBy: { createdAt: 'desc' }, include: { campaign: { select: { id: true, name: true } }, sequence: { select: { name: true } }, tasks: { orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }], select: { id: true, label: true, state: true, dueDate: true, completedAt: true } } } },
    },
  });
  if (!contact) notFound();
  const actor = toActor(user);
  const [settings, users] = await Promise.all([getSettings(), prisma.user.findMany({ where: { active: true, role: { in: ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER', 'ADMIN'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })]);
  const live = contact.status === 'ACTIVE';
  const mayWork = live && canWorkSandboxContact(actor, contact);
  const ready = checkReady(contact, { owner: contact.owner, podName: contact.pod?.name ?? null, settings: settings.sandbox });
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
  const timeline = [
    ...contact.calls.map((c) => ({ at: c.startedAt ?? c.createdAt, key: `c${c.id}`, node: <div><Link href={`/calls/${c.id}`} className="text-ink-900 hover:text-brand-700">{c.direction === 'OUTBOUND' ? 'Call' : 'Call received'}{c.talkSec ? ` · ${Math.floor(c.talkSec / 60)}m ${c.talkSec % 60}s` : ''}</Link><span className="text-ink-500"> · {c.user?.name ?? 'Unknown rep'}{c.form ? ` · ${outcomes.find((o) => o.key === c.form!.outcome)?.label ?? c.form.outcome}${c.form.rating ? ` (${c.form.rating}/5)` : ''}` : c.formDueAt ? ' · form due' : ''}</span>{c.form?.notes ? <p className="mt-1 whitespace-pre-wrap text-ink-700">{c.form.notes}</p> : null}{c.form ? <p className="text-ink-500">Next: {NEXT_STEP_LABELS[c.form.nextStep] ?? c.form.nextStep}{c.form.nextStepDate ? `, ${formatLocalDate(c.form.nextStepDate)}` : ''}</p> : null}{c.recordingSid ? <audio controls preload="none" className="mt-1 h-8" src={`/api/calls/${c.id}/recording`} /> : null}</div> })),
    ...contact.emails.map((m) => ({ at: m.at, key: `m${m.id}`, node: <div><span className="text-ink-900">{m.kind === 'SENT' ? 'Email sent' : m.kind === 'REPLY' ? 'Reply' : m.kind === 'BOUNCE' ? 'Bounced' : 'Auto-reply'}</span><span className="text-ink-500"> · {m.subject ?? '(no subject)'}</span></div> })),
    ...contact.notes.map((n) => ({ at: n.createdAt, key: `n${n.id}`, node: <div><span className="text-ink-900">Note</span><span className="text-ink-500"> · {n.authorName ?? 'Cadence'}</span><p className="mt-1 whitespace-pre-wrap text-ink-700">{n.body}</p></div> })),
    ...contact.enrollments.flatMap((e) => e.tasks.filter((t) => t.state === 'DONE' && t.completedAt).map((t) => ({ at: t.completedAt!, key: `t${t.id}`, node: <div><span className="text-ink-900">{t.label} done</span><span className="text-ink-500"> · {e.campaign?.name ?? e.sequence.name}</span></div> }))),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const input = (label: string, field: string, value: string | null | undefined, type = 'text') => <label className="block text-xs text-ink-500">{label}<input name={field} type={type} defaultValue={value ?? ''} disabled={!mayWork} className="mt-1 w-full" /></label>;

  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <Surface>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[12px] text-ink-500"><Link href="/sandbox" className="hover:text-ink-700">Sandbox</Link></div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{name}</h1>
          <div className="mt-1 text-sm text-ink-600">{[contact.jobTitle, contact.companyName].filter(Boolean).join(' · ') || 'No title or firm yet'}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={live ? 'green' : 'gray'}>{STATUS_LABEL[contact.status]}</Badge>
            {live ? <Badge tone={ready.ready ? 'green' : 'amber'}>{ready.ready ? 'Ready for CRM' : `Needs ${ready.missing.map((m) => m.text.toLowerCase()).join(', ')}`}</Badge> : null}
            <span className="text-ink-600">{contact.owner ? contact.owner.name : 'Unclaimed'}{contact.pod ? ` · ${contact.pod.name}` : ''}</span>
            {contact.status === 'MOVED' && contact.twentyPersonId ? <Link href={`/people/${contact.twentyPersonId}`} className="text-brand-700 hover:underline">Open in People</Link> : null}
            {contact.status !== 'MOVED' && contact.crmAutoPersonId ? <Link href={`/people/${contact.crmAutoPersonId}`} className="hover:underline"><Badge tone="amber">{`Also in CRM, created from ${contact.crmAutoSource === 'CALENDAR' ? 'calendar' : 'email'}`}</Badge></Link> : null}
            {live && contact.crmMatchPersonId && contact.crmMatchPersonId !== contact.crmAutoPersonId ? <Link href={`/people/${contact.crmMatchPersonId}`} className="hover:underline"><Badge tone="amber">Also in CRM</Badge></Link> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {contact.phone && live ? <CallButton phone={contact.phone} template={settings.rules.clickToCallUrl} sandboxContactId={contact.id} nextActionId={open?.id ?? null} blocked={callBlocked} warning={gate?.warning} /> : null}
          {live ? <ContactActions id={contact.id} ready={ready.ready} unclaimed={!contact.ownerId} mayWork={mayWork} mayOptOut={mayOptOut} mayMove={canMoveToCrm(actor, contact)} mayAssign={canAssignSandbox(actor, contact, null) && (isAdmin(user) || actor.role !== 'JUNIOR_FO')} mayErase={canEraseContact(actor)} users={users} /> : contact.status === 'REMOVED' || (contact.status === 'OPTED_OUT' && !contact.piiClearedAt) ? <ContactActions id={contact.id} ready={false} unclaimed={false} mayWork={false} mayOptOut={contact.status === 'REMOVED' && mayOptOut} mayMove={false} mayAssign={false} mayErase={canEraseContact(actor)} users={[]} /> : null}
        </div>
      </div>
    </Surface>
    <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
      <div className="space-y-4">
        <Surface flush>
          <ViewHeader title="Activity" />
          {timeline.length ? <ol className="divide-y divide-line">{timeline.map((item) => <li key={item.key} className="flex gap-4 px-4 py-3 text-[13px]"><time className="w-28 shrink-0 tabular-nums text-ink-500">{formatInstant(item.at, user.timezone)}</time><div className="min-w-0 flex-1">{item.node}</div></li>)}</ol> : <EmptyState title="Nothing has happened yet" />}
        </Surface>
        <Surface flush>
          <ViewHeader title="Campaigns" />
          {contact.enrollments.length ? <ul className="divide-y divide-line text-[13px]">{contact.enrollments.map((e) => <li key={e.id} className="px-4 py-2.5"><Link href={e.campaign ? `/sandbox/campaigns/${e.campaign.id}` : '#'} className="text-ink-900 hover:text-brand-700">{e.campaign?.name ?? e.sequence.name}</Link><span className="text-ink-500"> · {e.status === 'EXITED' ? `ended (${(e.exitReason ?? '').replace(/_/g, ' ')})` : e.status.toLowerCase()}</span><div className="mt-1 flex flex-wrap gap-1.5">{e.tasks.map((t) => <span key={t.id} className={t.state === 'DONE' ? 'text-brand-700' : t.state === 'PENDING' ? 'text-ink-900' : 'text-ink-400'}>{t.label}{t.state === 'PENDING' ? ` (${formatLocalDate(t.dueDate)})` : ''}</span>)}</div></li>)}</ul> : <EmptyState title="Not in a campaign" />}
        </Surface>
      </div>
      <div className="space-y-4">
        <Surface flush>
          <ViewHeader title="Next action" />
          <div className="space-y-3 p-4 text-[13px]">
            {open ? <div className="text-ink-900">{open.label} · {ACTION_LABELS[open.action]} · {formatLocalDate(open.dueDate, 'long')} <span className="text-ink-500">· {open.fo.name}</span></div> : <div className="text-ink-500">None set</div>}
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
