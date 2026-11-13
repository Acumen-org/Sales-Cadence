import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { accentFor } from '@/lib/accent';
import { formatInstant } from '@/lib/dates';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { shortDay } from '@/lib/task-cues';
import { loadContactPage, phoneTypeWords, phoneWords, type Blocker, type ContactPage } from '@/lib/sandbox/contact-page';
import { claimContactsAction, clearPossibleBounceAction, confirmPossibleBounceAction } from '@/lib/actions/sandbox';
import { ActionButton } from '@/components/action-form';
import { Flash } from '@/components/flash';
import { ActionIcon, IconExternal } from '@/components/icons';
import { Badge, Card, EventDetail, KeyValue, Notice, RecordHeader, Surface, Tabs, enrollmentStatusLabel, enrollmentTone } from '@/components/ui';
import { SubjectBadges } from '@/components/subject-badges';
import { CallButton } from '@/components/calls/call-button';
import { LogCallButton } from '@/components/calls/log-call';
import { SuggestionList } from '@/components/calls/suggestions';
import { FormOptOutControls } from '@/components/tickets/close-ticket-form';
import { EnrollmentActions } from '@/components/campaigns/enrollment-actions';
import { RemoveFromCampaign } from '@/components/campaigns/add-to-campaign';
import { UndoMoveButton } from '@/components/sandbox/move-undo';
import { AssignButton, ContactMoreMenu, MoveButton } from '@/components/sandbox/contact-actions';
import { AddToColdCampaign, ClaimWithPod, ColdNextStepButton, EditContactButton, FillFormButton, NoteComposer, PodPicker, type EditableContact } from '@/components/sandbox/contact-page';
import { ColdOutreachHeader } from '@/components/sandbox/section-tabs';
import { ColdListLink } from '@/components/sandbox/list-link';
import { coldRef, subjectHref } from '@/lib/subject';
import { linkedinSubjectView, type LinkedInSubjectView } from '@/lib/linkedin/subject-view';
import { LinkedInCard } from '@/components/linkedin/linkedin-card';

/** "Jane Doe · Cold outreach" (B115). */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const c = await prisma.sandboxContact.findUnique({ where: { id: (await params).id }, select: { firstName: true, lastName: true } });
  return { title: `${(c ? `${c.firstName} ${c.lastName}`.trim() : '') || 'Contact'} · Cold outreach` };
}

const TABS = ['overview', 'sequences', 'tasks', 'activity', 'emails', 'notes'] as const;
type Tab = (typeof TABS)[number];

type Search = { tab?: string; move?: string; flash?: string; flashTone?: string };

/**
 * One cold contact (PLAN 4.2), on the CRM person page's layout (B141): the record header with the
 * badge and chips, the one blocker with its fix, one row of buttons, then the same six tabs. Each
 * button a role can never use is hidden; each one that is off says why under it (B089, B202).
 */
export default async function ColdContactPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const m = await loadContactPage(id, user);
  if (!m) notFound();
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? (sp.tab as Tab) : 'overview';
  const header = <ColdOutreachHeader user={user} current="contacts" />;
  const c = m.contact;
  const href = (t: Tab) => `${subjectHref(coldRef(id))}${t === 'overview' ? '' : `?tab=${t}`}`;
  const openTasks = m.tasks.filter((t) => t.state === 'open').length;
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'sequences', label: 'Campaigns', count: m.memberships.length + m.holds.length },
    { key: 'tasks', label: 'Tasks', count: openTasks },
    { key: 'activity', label: 'Activity', count: m.history.length },
    { key: 'emails', label: 'Emails', count: m.emails.length + m.emailSteps.length },
    { key: 'notes', label: 'Notes', count: c.notes.length },
  ];
  // A result that survives the refresh, ending with what happens next (B148, PLAN 4.0).
  const flashTone = sp.flashTone === 'error' ? 'error' : 'ok';
  // The LinkedIn card is on the overview; a contact whose details were cleared has none to show.
  const linkedin = tab === 'overview' && !m.contact.piiClearedAt ? await linkedinSubjectView({ sandboxContactId: id }, user.timezone) : null;
  const flash = sp.flash ? `${sp.flash.slice(0, 300)}${flashTone === 'ok' && m.nextLine && !/Next:/.test(sp.flash) ? ` ${m.nextLine}` : ''}` : null;

  return <>
    <div className="space-y-3 px-6 pt-2">
      {header}
      {/* B192: back to the list as the reader left it, view and filters kept. */}
      <div className="text-[12px] text-ink-500"><ColdListLink className="hover:text-ink-700">Cold outreach</ColdListLink> › <span className="text-ink-700">{m.name}</span></div>
      <RecordHeader
        name={m.name}
        sub={m.sub || null}
        accent={m.live || m.contact.status === 'MOVED' ? accentFor(id) : null}
        seed={id}
        stackOnPhone
        badges={<>
          <SubjectBadges badge={m.cue.badge} chips={m.cue.chips} />
          {m.erased ? <Badge tone="gray">Erased</Badge> : null}
          {/* B068: what Bellwether knows that the contact does not, to check before the next step. */}
          {m.live && m.newerNote ? <Link href={m.newerNote.href} className="inline-flex hover:opacity-80"><Badge tone="sky">Newer details from Bellwether</Badge></Link> : null}
        </>}
        notice={<TopNotices m={m} />}
        actions={m.live ? <ButtonRow m={m} openMove={sp.move === '1'} timezone={user.timezone} /> : <TombstoneActions m={m} />}
      />
    </div>
    <div className="px-6 pb-8 pt-3">
      <Surface flush><Tabs inset={false} current={tab} tabs={tabs.map((t) => ({ ...t, href: href(t.key as Tab) }))} /></Surface>
      <div className="pt-3">
        {tab === 'overview' ? <Overview m={m} timezone={user.timezone} linkedin={linkedin} /> : null}
        {tab === 'sequences' ? <Campaigns m={m} /> : null}
        {tab === 'tasks' ? <TasksTab m={m} /> : null}
        {tab === 'activity' ? <Activity m={m} timezone={user.timezone} /> : null}
        {tab === 'emails' ? <Emails m={m} timezone={user.timezone} /> : null}
        {tab === 'notes' ? <Notes m={m} timezone={user.timezone} /> : null}
      </div>
    </div>
    {flash ? <Flash message={flash} tone={flashTone} /> : null}
  </>;
}

/** The fix button a blocker names (PLAN 4.0): one per notice. */
function FixButton({ m, fix }: { m: ContactPage; fix: NonNullable<Blocker['fix']> }) {
  switch (fix.kind) {
    case 'form': return <FillFormButton />;
    case 'claim': return m.claimPods ? <ClaimWithPod id={m.id} pods={m.claimPods} label={fix.label} className="btn-primary btn-sm" /> : <ActionButton action={claimContactsAction} payload={{ ids: m.id }} flash>{fix.label}</ActionButton>;
    case 'assign': return <AssignButton id={m.id} name={m.name} users={m.owners} ownerId={c(m).ownerId} work={m.work} />;
    case 'move': return <MoveButton id={m.id} ready users={m.owners} pods={m.pods} label={fix.label} />;
    case 'next_step': return <ColdNextStepButton id={m.id} today={m.today} workingDays={m.settings.rules.workingDays} initial={{ label: '', action: 'CALL', dueDate: m.today, repeat: 'NONE', foUserId: '' }} />;
    case 'link': return <Link href={fix.href ?? '#'} className="btn-secondary btn-sm">{fix.label}</Link>;
  }
}
const c = (m: ContactPage) => m.contact;

/** The top of the record: the blocker, or the tombstone, and a possible bounce to check (N097). */
function TopNotices({ m }: { m: ContactPage }) {
  const notices: ReactNode[] = [];
  const b = m.banner;
  if (b?.kind === 'moved') notices.push(<Notice key="b" tone="success"><span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
    <span>{b.text}.</span>
    {b.personHref ? <Link href={b.personHref} className="font-medium underline">Open in People</Link> : null}
    {b.undoUntil ? <span>Undo until {b.undoUntil}</span> : null}
    {b.move?.canUndo ? <UndoMoveButton itemIds={[b.move.itemId]} confirm={b.move.undoConfirm} campaigns={b.move.campaigns} /> : null}
    <span className="text-[12.5px]">To opt them out, use their People page.</span>
  </span></Notice>);
  // N104: red, with who set it, when and where, and what it means for the rep.
  if (b?.kind === 'do_not_contact') notices.push(<Notice key="b" tone="error"><div className="space-y-1.5">
    <div><span className="font-semibold">Do not contact</span>{b.since ? ` since ${b.since}` : ''}{b.by ? `, set by ${b.by}` : ''} on {b.where}.{b.reason ? ` Why: ${b.reason}` : ''}</div>
    <div>Do not email, call or message this person. Cadence blocks calls and campaigns.</div>
    {m.formOpt ? <div className="flex flex-wrap items-center gap-2">{m.formOpt.lastTicket?.outcome === 'kept' ? <span className="text-[12.5px]">Biz Ops checked it: {m.formOpt.lastTicket.resolution ?? 'it stays'}.</span> : null}<FormOptOutControls subject={{ sandboxContactId: m.id }} name={m.name} mayLift={m.admin} ticket={m.formOpt.ticket ? `Biz Ops are looking at it: raised by ${m.formOpt.ticket.raisedBy ?? 'someone'}.` : null} />{m.formOpt.callId ? <Link href={`/calls/${m.formOpt.callId}`} className="text-[12.5px] underline">The call</Link> : null}</div> : null}
  </div></Notice>);
  // B150: who, when, and what was cleared; N027: what can still be done.
  if (b?.kind === 'removed') notices.push(<Notice key="b" tone="warn"><div className="space-y-1">
    <div><span className="font-semibold">Removed</span> by {b.by}{b.on ? ` on ${b.on}` : ''}.{b.reason ? ` Why: ${b.reason}` : ''}</div>
    <div>Their name, email, phones, LinkedIn, firm and notes were cleared. Calls, emails and steps keep only their dates and outcomes. Bellwether may send this person again.</div>
    {m.more.show ? <div>Anyone in sales can still opt them out{m.more.mayErase ? ', and you can erase them' : ''}: More, below.</div> : null}
  </div></Notice>);
  if (b?.kind === 'erased') notices.push(<Notice key="b" tone="error"><div className="space-y-1">
    <div><span className="font-semibold">Erased</span> by {b.by}{b.on ? ` on ${b.on}` : ''}.</div>
    <div>Every detail Cadence held was deleted: name, email, phones, notes, call notes and email subjects. They stay on the suppression list, so Cadence and Bellwether never contact them again.</div>
  </div></Notice>);
  // The fix is a button only when the row below does not hold the same one (Set next step, Move to CRM).
  const inRow = (k: string) => m.live && m.sales && !m.readOnly && (k === 'next_step' || k === 'move');
  if (m.blocker) notices.push(<Notice key="blk" tone={m.blocker.tone}><span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"><span>{m.blocker.text}</span>{m.blocker.fix && !inRow(m.blocker.fix.kind) ? <FixButton m={m} fix={m.blocker.fix} /> : null}</span></Notice>);
  // B017, B068: anyone in the CRM, or in Cold outreach, this may be: worth knowing before a call or a move.
  const s = m.source;
  if (m.live && s.inCrm && !/in the CRM already/.test(m.blocker?.text ?? '')) notices.push(<Notice key="crm" tone="info">Already in the CRM: <Link href={s.inCrm.href} className="font-medium underline">{s.inCrm.name}</Link>{s.inCrm.owner ? `, ${s.inCrm.owner}'s` : ''}. Move to CRM adds this history to them.</Notice>);
  if (m.live && s.possibleCrm) notices.push(<Notice key="pcrm" tone="info">Possibly in the CRM: <Link href={s.possibleCrm.href} className="font-medium underline">{s.possibleCrm.name}</Link>{[s.possibleCrm.firm, s.possibleCrm.owner].filter(Boolean).length ? ` (${[s.possibleCrm.firm, s.possibleCrm.owner].filter(Boolean).join(', ')})` : ''}. Check before you call or move.</Notice>);
  if (m.live && s.possibleTwin) notices.push(<Notice key="twin" tone="warn">Possibly the same as <Link href={s.possibleTwin.href} className="font-medium underline">{s.possibleTwin.name}</Link>{s.possibleTwin.owner ? `, ${s.possibleTwin.owner}'s contact` : ''}: same firm and last name, or the same office line.</Notice>);
  // N097: a notice that may be a bounce: the rep checks the address, then clears or confirms it.
  if (m.possibleBounce) notices.push(<Notice key="pb" tone="warn"><span className="flex flex-wrap items-center gap-2">
    <span>A notice on {m.possibleBounce.on} may be a bounce. Check {m.contact.email ?? 'the address'}.</span>
    {m.possibleBounce.mayAct ? <><ActionButton action={clearPossibleBounceAction} payload={{ id: m.id }} className="btn-secondary btn-sm" flash>Clear</ActionButton><ActionButton action={confirmPossibleBounceAction} payload={{ id: m.id }} className="btn-secondary btn-sm" flash confirm={{ title: `Mark ${m.name}'s email bounced?`, effects: ['The address is marked bounced.', 'Their open email steps are skipped, as "Email bounced" would.', 'Their campaign ends when "exit on bounce" is on in Settings > Rules.'], confirmLabel: 'Mark bounced' }}>Confirm bounce</ActionButton></> : <span className="text-ink-600">Whoever works this contact can clear or confirm it.</span>}
  </span></Notice>);
  return notices.length ? <>{notices}</> : null;
}

/** Call, Email, LinkedIn, Log a call, Set next step, Move to CRM, More: equal buttons, each saying why when off. */
function ButtonRow({ m, openMove, timezone }: { m: ContactPage; openMove: boolean; timezone: string }) {
  if (!m.sales) return null;
  // A contact this reader may not work: the buttons are off and say why once, not under each (B202).
  const shared = m.readOnly ? m.workWhy : null;
  // Why a button is off: on the button (hover) and once, in one line under the row, so the buttons stay in a line.
  const offs: string[] = [];
  const disabled = (label: ReactNode, reason: string | null) => {
    if (reason && !shared && !offs.includes(reason)) offs.push(reason);
    return <button type="button" className="btn-secondary btn-sm" disabled title={reason ?? undefined}>{label}</button>;
  };
  if (m.move.blocked && !shared) offs.push(m.move.blocked);
  const nowLocal = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
  return <div className="flex w-full flex-wrap items-start gap-2">
    {m.call.phone && !shared ? <span className="inline-flex max-w-[13rem] flex-col"><CallButton phone={m.call.phone} template={m.settings.rules.clickToCallUrl} sandboxContactId={m.id} nextActionId={m.call.nextActionId} blocked={m.call.blocked} warning={m.call.warning} className="btn-secondary btn-sm" ariaLabel={`Call ${m.name}`} claim={m.call.claim ? { action: claimContactsAction, payload: { ids: m.id } } : null} /></span> : disabled(<><ActionIcon action="CALL" size={13} /> Call</>, m.call.blocked)}
    {/* N074: Email opens the mail app and LinkedIn the profile. */}
    {m.email.blocked || !m.email.href ? disabled(<><ActionIcon action="EMAIL" size={13} /> Email</>, m.email.blocked) : <a href={m.email.href} className="btn-secondary btn-sm"><ActionIcon action="EMAIL" size={13} /> Email</a>}
    {m.linkedin.blocked || !m.linkedin.href ? disabled(<><ActionIcon action="LINKEDIN_MESSAGE" size={13} /> LinkedIn</>, m.linkedin.blocked) : <a href={m.linkedin.href} target="_blank" rel="noreferrer" className="btn-secondary btn-sm"><ActionIcon action="LINKEDIN_MESSAGE" size={13} /> LinkedIn</a>}
    {shared ? disabled('Log a call', null) : <span className="inline-flex max-w-[13rem] flex-col"><LogCallButton sandboxContactId={m.id} name={m.name} steps={m.logCall.steps} now={nowLocal} blocked={m.logCall.blocked} /></span>}
    {m.nextStep.blocked ? disabled('Set next step', m.nextStep.blocked) : <ColdNextStepButton id={m.id} today={m.today} workingDays={m.settings.rules.workingDays} label={m.nextStep.open ? 'Change next step' : 'Set next step'} initial={m.nextStep.open ? { label: m.nextStep.open.label, action: m.nextStep.open.action, dueDate: m.nextStep.open.dueDate < m.today ? m.today : m.nextStep.open.dueDate, repeat: 'NONE', foUserId: '' } : { label: '', action: 'CALL', dueDate: m.today, repeat: 'NONE', foUserId: '' }} existing={m.nextStep.open ? { label: m.nextStep.open.label, dueDate: m.nextStep.open.dueDate } : null} />}
    {/* Move to CRM is the main button only when the badge says Ready to move (D3). */}
    {shared ? disabled('Move to CRM', null) : <MoveButton id={m.id} ready={m.move.ready} users={m.owners} pods={m.pods} openMove={openMove} blocked={m.move.blocked} reasonBelow={false} />}
    {m.more.show ? <ContactMoreMenu id={m.id} name={m.name} ready={m.move.ready} unclaimed={!c(m).ownerId} mayWork={m.mayWork} mayOptOut={m.more.mayOptOut} mayMove={!m.move.blocked} mayRemove={m.more.mayRemove} mayAssign={m.more.mayAssign} mayRelease={m.more.mayRelease} mayErase={m.more.mayErase} users={m.owners} ownerId={c(m).ownerId} work={m.work} confirms={m.confirms} whyNot={m.more.whyNot} /> : null}
    {offs.length ? <p className="w-full text-[12px] text-ink-600">{offs.join(' · ')}</p> : null}
    {m.readOnlyLine ? <p className="w-full text-[12px] text-ink-600">{m.readOnlyLine}</p> : null}
  </div>;
}

/** A contact no longer worked here: Open in People for a moved one; Opt out and Erase for a removed one (N027). */
function TombstoneActions({ m }: { m: ContactPage }) {
  const b = m.banner;
  const items: ReactNode[] = [];
  if (b?.kind === 'moved' && b.personHref) items.push(<Link key="p" href={b.personHref} className="btn-secondary btn-sm">Open in People</Link>);
  if (m.more.show) items.push(<ContactMoreMenu key="more" id={m.id} name={m.name} ready={false} unclaimed={false} mayWork={false} mayOptOut={m.more.mayOptOut} mayMove={false} mayRemove={false} mayAssign={false} mayErase={m.more.mayErase} users={[]} confirms={m.confirms} />);
  return items.length ? <div className="flex flex-wrap items-start gap-2">{items}</div> : null;
}

/**
 * Overview, in two columns that stack on their own (no gaps between cards of different heights):
 * the next step and the contact's details on the left; who owns it, where it came from and LinkedIn
 * on the right. No checklist (owner, 13 Nov 2026): what a move still needs is the notice at the top.
 */
function Overview({ m, timezone, linkedin }: { m: ContactPage; timezone: string; linkedin: LinkedInSubjectView | null }) {
  const ct = c(m);
  const n = m.nextStep.open;
  const how = n ? (n.kind === 'MEETING' ? 'Meeting' : ACTION_LABELS[n.action]) : null;
  const campaignNext = m.cue.next?.source === 'campaign' ? m.cue.next : null;
  const editable: EditableContact = {
    firstName: ct.firstName, lastName: ct.lastName, jobTitle: ct.jobTitle ?? '', email: ct.email ?? '', phone: ct.phone ?? '', phoneExtension: ct.phoneExtension ?? '', phoneType: ct.phoneType ?? 'unknown',
    linkedinUrl: ct.linkedinUrl ? `https://www.${ct.linkedinUrl}` : '', city: ct.city ?? '', state: ct.state ?? '', country: ct.country ?? 'US', companyName: ct.companyName ?? '', companyWebsite: ct.companyWebsite ?? ct.companyDomain ?? '',
    companyCrd: ct.companyCrd ?? '', individualCrd: ct.individualCrd ?? '', productInterest: ct.productInterest,
  };
  const edit = (label: string, focus?: 'firstName' | 'companyName' | 'email' | 'linkedinUrl', className?: string) => m.edit.may ? <EditContactButton id={m.id} contact={editable} version={m.edit.version} countries={m.countries} products={m.productChoices} label={label} focus={focus} className={className} /> : null;
  const src = m.source;
  // Every way a rep reaches them shows, empty or not; the rest only when there is something.
  const optional = (k: string, v: ReactNode) => (v ? [{ k, v }] : []);
  const details = [
    { k: 'Email', v: ct.email ? <span className="flex flex-wrap items-center gap-1.5"><a href={`mailto:${ct.email}`} className="text-brand-700 hover:underline">{ct.email}</a>{m.details.verification.map((v) => <Badge key={v.label} tone={v.tone}>{v.label}</Badge>)}</span> : null },
    ...optional('Other emails', ct.additionalEmails.join(', ')),
    { k: 'Phone', v: ct.phone ? <span className="flex flex-wrap items-center gap-1.5"><span className="tabular-nums">{phoneWords(ct.phone, ct.phoneExtension)}</span><span className="text-ink-500">{phoneTypeWords(ct.phoneType)}</span>{ct.badPhone ? <Badge tone="amber">Wrong number</Badge> : null}</span> : null },
    ...optional('Other phones', m.details.extraPhones.length ? m.details.extraPhones.map((p) => `${phoneWords(p.number)} (${phoneTypeWords(p.type).toLowerCase()})`).join(', ') : null),
    { k: 'LinkedIn', v: ct.linkedinUrl ? <a href={`https://www.${ct.linkedinUrl}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{ct.linkedinUrl.replace(/^linkedin\.com\//, '')}</a> : null },
    { k: 'Title', v: ct.jobTitle },
    { k: 'Firm', v: ct.companyName ? <span>{ct.companyName}{ct.companyWebsite || ct.companyDomain ? <> · <a href={(ct.companyWebsite ?? `https://${ct.companyDomain}`).replace(/^(?!https?:\/\/)/, 'https://')} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{ct.companyDomain ?? ct.companyWebsite}</a></> : null}</span> : null },
    { k: 'Location', v: [ct.city, ct.state, ct.country ? new Intl.DisplayNames(['en'], { type: 'region' }).of(ct.country) ?? ct.country : null].filter(Boolean).join(', ') || null },
    ...optional('Firm CRD', ct.companyCrd),
    ...optional('Individual CRD', ct.individualCrd),
    ...optional('Designations', ct.designations.length ? <Chips values={ct.designations} /> : null),
    ...optional('Tags', ct.tags.length ? <Chips values={ct.tags} /> : null),
    ...optional('Product interest', m.details.products),
  ];
  const owner = ct.owner ? <span className={ct.owner.active ? undefined : 'text-ink-500'}>{ct.owner.name}{ct.owner.active ? '' : ' (has left)'}</span> : null;
  const added = src.kind === 'BELLWETHER' ? <>From Bellwether{src.by ? <>, sent by <span title={src.byEmail ?? undefined}>{src.by}</span></> : null} on {src.on}</> : src.kind === 'MANUAL' ? <>Added in Cadence{src.by ? ` by ${src.by}` : ''} on {src.on}</> : <>Added from a call{src.by ? ` by ${src.by}` : ''} on {src.on}</>;
  return <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
    <div className="min-w-0 space-y-3">
      {m.live ? <Card title="Next step" actions={m.nextStep.blocked || !m.sales ? null : <ColdNextStepButton id={m.id} today={m.today} workingDays={m.settings.rules.workingDays} label={n ? 'Change' : 'Set next step'} className="btn-ghost btn-sm" initial={n ? { label: n.label, action: n.action, dueDate: n.dueDate < m.today ? m.today : n.dueDate, repeat: 'NONE', foUserId: '' } : { label: '', action: 'CALL', dueDate: m.today, repeat: 'NONE', foUserId: '' }} existing={n ? { label: n.label, dueDate: n.dueDate } : null} />}>
        <div className="space-y-3 p-4 text-[13px]">
          {n ? <div>
            <div className={n.dueDate < m.today ? 'font-medium text-red-700' : 'font-medium text-ink-900'}>{how} · {shortDay(n.dueDate)}{n.meetingAt ? ` at ${new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(n.meetingAt)}` : ''}{n.dueDate < m.today ? ' (overdue)' : ''} · {n.fo.name}</div>
            {n.label && n.label !== how ? <div className="mt-0.5 text-ink-600">{n.label}</div> : null}
          </div> : <p className="text-ink-600">{m.cue.state === 'closed' ? `${m.cue.badge.label}. A new next step reopens ${m.firstName}.` : campaignNext ? 'No next step of its own: the campaign holds the next touch.' : 'None set yet.'}</p>}
          {campaignNext ? <div className="text-ink-700">Campaign: {campaignNext.label} · {shortDay(campaignNext.due)}{campaignNext.overdue ? ' (overdue)' : ''}</div> : null}
          {m.nextStep.blocked && m.sales ? <p className="text-[12.5px] text-ink-500">{m.nextStep.blocked}</p> : null}
          <SuggestionList items={m.suggestions.map((s) => ({ id: s.id, from: s.from, words: s.words }))} />
        </div>
      </Card> : null}

      {/* B142: phone with its type and extension, email with its verification, designations and tags. */}
      {m.contact.piiClearedAt ? null : <Card title="Contact details" actions={m.edit.may ? edit('Edit', undefined, 'btn-ghost btn-sm') : m.edit.why ? <span className="text-[12px] text-ink-500">{m.edit.why}</span> : null}>
        <div className="p-4"><KeyValue items={details} /></div>
      </Card>}
    </div>

    <div className="min-w-0 space-y-3">
      {/* Who works them, and where they came from (B205, B143, B017), as the CRM page's Ownership card. */}
      {m.contact.piiClearedAt ? null : <Card title="Ownership" actions={src.bellwetherUrl && !m.contact.piiClearedAt ? <a href={src.bellwetherUrl} target="_blank" rel="noreferrer" className="btn-ghost btn-sm"><IconExternal size={13} /> Bellwether</a> : null}>
        <div className="p-4">
          <KeyValue items={[
            { k: 'Owner', v: <span className="flex flex-wrap items-center gap-2">{owner ?? <span className="text-ink-500">Nobody yet</span>}{m.live && (!ct.owner || !ct.owner.active) ? <OwnerFix m={m} /> : null}</span> },
            { k: 'Pod', v: m.checklist?.podPicker ? <PodPicker id={m.id} pods={m.checklist.podPicker} current={ct.podId} /> : ct.pod?.name ?? null },
            ...(m.contact.piiClearedAt ? [] : [{ k: 'Came from', v: <span>{added}{src.collected ? <span className="text-ink-500"> · found {src.collected}</span> : null}</span> }]),
            ...(src.note && !m.contact.piiClearedAt ? [{ k: 'Source note', v: <span className="whitespace-pre-wrap">{src.note}</span> }] : []),
            ...(src.later.length ? [{ k: 'Sent again', v: <span>{src.later.map((p, i) => <span key={i} className="block">{p.by ? <span title={p.email}>{p.by}</span> : 'Bellwether'}, {p.on}</span>)}</span> }] : []),
          ]} />
        </div>
      </Card>}

      {/* What the LinkedIn Console saw; with no profile link yet, Edit adds it. */}
      {linkedin ? <LinkedInCard view={linkedin} hasLink={Boolean(ct.linkedinUrl)} addLink={m.live ? edit('Add LinkedIn link', 'linkedinUrl', 'btn-secondary btn-sm') : null} /> : null}
    </div>
  </div>;
}

/** Owner missing or gone: Claim, Assign, or who can fix it. */
function OwnerFix({ m }: { m: ContactPage }) {
  if (m.mayClaim && !m.admin) return m.claimPods ? <ClaimWithPod id={m.id} pods={m.claimPods} /> : <ActionButton action={claimContactsAction} payload={{ ids: m.id }} className="btn-secondary btn-sm" flash>Claim</ActionButton>;
  if (m.more.mayAssign) return <AssignButton id={m.id} name={m.name} users={m.owners} ownerId={c(m).ownerId} work={m.work} />;
  return <span className="text-[12px] text-ink-500">{c(m).owner && !c(m).owner!.active ? 'A pod leader assigns a new owner' : 'A rep in its pod claims it'}</span>;
}

function Chips({ values }: { values: string[] }) {
  return <span className="flex flex-wrap gap-1">{values.map((t) => <span key={t} className="rounded border border-line bg-canvas px-1.5 py-0.5 text-[11.5px] text-ink-700">{t}</span>)}</span>;
}

/** Campaigns (B144, B145): holds of campaigns not started yet and every enrollment, with Pause, Resume and Exit. */
function Campaigns({ m }: { m: ContactPage }) {
  return <div className="space-y-3">
    <Card title="Campaigns" actions={m.mayEnroll ? <AddToColdCampaign id={m.id} /> : null}>
      {!m.memberships.length && !m.holds.length ? <div className="p-4 text-[13px] text-ink-500">Not in a campaign.{m.drafts.length ? ' A draft holds nobody until it is published.' : ''}{m.mayEnroll ? ` Add ${m.firstName} to a cold campaign, or set a next step.` : ''}</div> : null}
      {m.holds.length ? <ul className="divide-y divide-line">{m.holds.map((h) => <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13px]">
        <span className="text-ink-700">In <Link href={`/campaigns/${h.id}`} className="font-medium text-ink-900 hover:text-brand-700">{h.name}</Link>, {h.words}</span>
        <span className="flex items-center gap-2"><Badge tone="purple">Upcoming</Badge>{h.mayRemove ? <RemoveFromCampaign campaignId={h.id} campaignName={h.name} personIds={[m.id]} className="btn-ghost btn-sm" label="Take out" /> : null}</span>
      </li>)}</ul> : null}
      {/* S7: a draft holds nobody; it is named as a draft that has not started, and blocks nothing. */}
      {m.drafts.length ? <ul className="divide-y divide-line border-t border-line">{m.drafts.map((d) => <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13px]">
        <span className="text-ink-600">In draft: <Link href={`/campaigns/${d.id}`} className="font-medium text-ink-900 hover:text-brand-700">{d.name}</Link> (not started)</span>
        <span className="flex items-center gap-2"><Badge tone="gray">Draft</Badge>{d.mayRemove ? <RemoveFromCampaign campaignId={d.id} campaignName={d.name} personIds={[m.id]} className="btn-ghost btn-sm" label="Take out" /> : null}</span>
      </li>)}</ul> : null}
    </Card>
    {m.memberships.map((e) => <Card key={e.id} title={e.campaignId ? <Link href={`/campaigns/${e.campaignId}`} className="font-medium hover:underline">{e.name}</Link> : e.name} actions={<span className="flex items-center gap-2"><Badge tone={enrollmentTone(e)}>{enrollmentStatusLabel(e)}</Badge>{e.mayManage ? <EnrollmentActions enrollmentId={e.id} status={e.status} foUserId="" fos={[]} flash exitConfirm={{ title: `Take ${m.name} out of ${e.name}?`, effects: ['Their open steps in it are cancelled.', 'They stay in Cold outreach: set a next step after.'], confirmLabel: 'Take out' }} /> : null}</span>}>
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line bg-canvas/50 px-4 py-2.5 text-[12.5px] text-ink-600"><span>FO {e.fo}</span><span>Started {e.started}</span>{e.stepAt ? <span>Step {e.stepAt} of {e.stepCount}</span> : null}</div>
      {e.steps.length ? <ul className="flex flex-wrap gap-1.5 p-4">{e.steps.map((st) => <li key={st.id}><Badge tone={st.tone}>{st.label}: {st.words}</Badge></li>)}</ul> : <div className="p-4 text-[13px] text-ink-500">No steps yet.</div>}
    </Card>)}
  </div>;
}

/** Tasks: open and done steps and next steps. */
function TasksTab({ m }: { m: ContactPage }) {
  const open = m.tasks.filter((t) => t.state === 'open').sort((a, b) => a.at - b.at);
  const done = m.tasks.filter((t) => t.state !== 'open').sort((a, b) => b.at - a.at);
  const row = (t: ContactPage['tasks'][number]) => <li key={t.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
    <ActionIcon action={t.icon} size={14} className="text-ink-500" />
    {t.href ? <Link href={t.href} className="font-medium text-ink-900 hover:text-brand-700">{t.label}</Link> : <span className="font-medium text-ink-800">{t.label}</span>}
    <span className="text-ink-500">{t.where}{t.fo ? ` · ${t.fo}` : ''}</span>
    <span className={t.overdue ? 'ml-auto text-red-700' : 'ml-auto text-ink-500'}>{t.when}</span>
  </li>;
  return <div className="space-y-3">
    <Card title="Open">{open.length ? <ul className="divide-y divide-line">{open.map(row)}</ul> : <div className="p-4 text-[13px] text-ink-500">Nothing open.{m.live && m.cue.state === 'no_next_step' ? ` Set a next step for ${m.firstName}.` : ''}</div>}</Card>
    <Card title="Done">{done.length ? <ul className="divide-y divide-line">{done.map(row)}</ul> : <div className="p-4 text-[13px] text-ink-500">Nothing done yet.</div>}</Card>
  </div>;
}

/** Activity (B140): every event, newest first, in words (S8's describeAudit). */
function Activity({ m, timezone }: { m: ContactPage; timezone: string }) {
  return <Card title="Activity">
    {m.history.length ? <ol className="divide-y divide-line">{m.history.map((it) => <li key={it.key} className="flex gap-3 px-4 py-2.5 text-sm">
      <span className={it.tone === 'in' ? 'mt-0.5 text-emerald-600' : 'mt-0.5 text-ink-500'}>{it.icon === 'NOTE' || it.icon === 'STATE' ? <span className="inline-block h-3.5 w-3.5 rounded-full border border-current" /> : <ActionIcon action={it.icon} size={14} />}</span>
      <span className="min-w-0 flex-1 space-y-1">
        {it.href ? <Link href={it.href} className="block text-ink-800 hover:text-brand-700">{it.title}</Link> : <span className="block text-ink-800">{it.title}</span>}
        {it.detail ? <span className="block max-w-[70ch] whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-700">{it.detail}</span> : null}
        {it.fields?.length ? <EventDetail fields={it.fields} /> : null}
        {it.recordingHref ? <audio controls preload="none" className="h-8" src={it.recordingHref} /> : null}
      </span>
      <span className="shrink-0 text-xs text-ink-500">{formatInstant(it.at, timezone)}</span>
    </li>)}</ol> : <div className="p-4 text-sm text-ink-500">Nothing has happened yet.</div>}
  </Card>;
}

/** Emails (W10): sent, replies and bounces Outlook tracking saw, newest first. */
function Emails({ m, timezone }: { m: ContactPage; timezone: string }) {
  const kind = { SENT: 'Sent', REPLY: 'Reply', BOUNCE: 'Bounced', AUTO_REPLY: 'Auto-reply' } as Record<string, string>;
  return <div className="space-y-3">
    {!m.tracked ? <Notice tone="info">Email tracking is off. Emails show here only when a step is marked Done.</Notice> : null}
    <Card title="Emails">
      {m.emails.length || m.emailSteps.length ? <ol className="divide-y divide-line">
        {m.emails.map((e) => <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
          <Badge tone={e.kind === 'REPLY' ? 'green' : e.kind === 'BOUNCE' ? 'amber' : e.kind === 'SENT' ? 'blue' : 'gray'}>{kind[e.kind] ?? e.kind}</Badge>
          <span className="min-w-0 flex-1 truncate text-ink-800">{e.subject ?? '(no subject)'}</span>
          <span className="text-ink-500">{e.mailbox ? `${e.mailbox}'s mailbox · ` : ''}{formatInstant(e.at, timezone)}</span>
        </li>)}
        {m.emailSteps.map((e) => <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
          <Badge tone="gray">Marked done</Badge>
          <span className="min-w-0 flex-1 truncate text-ink-800">{e.label} · {e.where}</span>
          <span className="text-ink-500">{e.by} · {formatInstant(e.at, timezone)}</span>
        </li>)}
      </ol> : <div className="p-4 text-[13px] text-ink-500">No emails yet.</div>}
    </Card>
  </div>;
}

/** Notes: the composer and every note, as on the CRM page. */
function Notes({ m, timezone }: { m: ContactPage; timezone: string }) {
  const notes = c(m).notes;
  return <Card title="Notes">
    {m.mayWork ? <div className="border-b border-line"><NoteComposer id={m.id} /></div> : m.live && m.workWhy ? <p className="border-b border-line px-4 py-3 text-[12.5px] text-ink-500">{m.workWhy === 'Claim first' ? `Claim ${m.firstName} first to add notes.` : m.workWhy}</p> : null}
    {notes.length ? <ol className="divide-y divide-line">{notes.map((n) => <li key={n.id} id={`note-${n.id}`} className="scroll-mt-24 px-4 py-3 text-[13px]">
      <div className="text-[12px] text-ink-500">{n.authorName ?? 'Cadence'} · {formatInstant(n.createdAt, timezone)}</div>
      <p className="mt-1 max-w-[70ch] whitespace-pre-wrap break-words text-ink-800">{n.body}</p>
    </li>)}</ol> : <div className="p-4 text-[13px] text-ink-500">No notes yet.</div>}
  </Card>;
}

export const dynamic = 'force-dynamic';
