import Link from 'next/link';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { refOf, subjectHref } from '@/lib/subject';
import { consoleProfileLink } from '@/lib/linkedin/keys';
import { followUpLabel } from '@/lib/linkedin/follow-ups';
import type { AccountView, FollowUpRow } from '@/lib/linkedin/tasks-view';
import { ActionIcon, IconExternal } from '@/components/icons';
import { Avatar, Badge, Notice, RecordFields, Surface } from '@/components/ui';
import { LinkedInFollowUpControls } from './linkedin-follow-up-controls';

/*
 * Follow-ups Cadence opened from what it saw: LinkedIn ones from the LinkedIn Console (src/lib/linkedin) -
 * message someone who accepted or wrote back, withdraw a request left waiting, send it again after
 * LinkedIn's cool-off - and "Reply to their email" when someone answers an email (owner, 13 Nov 2026).
 * Cadence never acts on LinkedIn: a LinkedIn task opens the person in the Console, where the teammate
 * does it by hand. Each closes itself when Cadence sees it done.
 */

export function followUpSubject(f: Pick<FollowUpRow, 'person' | 'sandboxContact' | 'link'>) {
  const who = f.person ?? f.sandboxContact;
  const name = (who ? `${who.firstName} ${who.lastName}`.trim() : '') || 'LinkedIn member';
  return { name, who, profileKey: f.person?.linkedinKey ?? f.link?.profileKey ?? null };
}

const actionOf = (f: Pick<FollowUpRow, 'kind'>) => (f.kind === 'EMAIL_REPLY' ? 'EMAIL' : f.kind === 'MESSAGE' ? 'LINKEDIN_MESSAGE' : 'LINKEDIN_CONNECT');

/** Why the task exists, in a few words. */
export function followUpWhy(f: Pick<FollowUpRow, 'kind' | 'trigger' | 'triggeredAt' | 'link'>, timezone: string): string {
  const on = (d: Date | null) => (d ? formatInstant(d, timezone).split(',')[0] : 'recently');
  if (f.kind === 'EMAIL_REPLY') return `Replied on ${on(f.triggeredAt)}`;
  if (f.kind === 'MESSAGE') return f.trigger === 'replied' ? `Wrote to us on LinkedIn on ${on(f.triggeredAt)}` : `Accepted our connection request on ${on(f.link?.acceptedAt ?? f.triggeredAt)}`;
  if (f.kind === 'WITHDRAW') return `Our request has waited since ${on(f.link?.invitedAt ?? null)} with no answer`;
  return `Our request was withdrawn on ${on(f.link?.withdrawnAt ?? f.triggeredAt)}; LinkedIn lets it go again after 3 weeks`;
}

const dueLabel = (due: string | null, today: string) => (!due ? 'No owner' : due === today ? 'Today' : formatLocalDate(due));

/** Follow-ups (replies and LinkedIn) at the top of a tab's list: whose, what, when. */
export function LinkedInFollowUpList({ items, selectedId, today, showFo, href }: { items: FollowUpRow[]; selectedId: string | null; today: string; showFo: boolean; href: (id: string) => string }) {
  return <div className="border-b border-line">
    <div className="bg-canvas/60 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-500">Replies and LinkedIn <span className="tabular-nums">· {items.length}</span></div>
    <ul className="divide-y divide-line">{items.map((f) => {
      const { name } = followUpSubject(f);
      return <li key={f.id}>
        <Link href={href(f.id)} aria-current={f.id === selectedId ? 'true' : undefined} className={`flex items-start gap-3 px-3 py-2.5 transition hover:bg-brand-50/50 ${f.id === selectedId ? 'bg-brand-50' : ''}`}>
          <Avatar name={name} shape="circle" size={30} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-900">{name}</span><span className={`shrink-0 text-[12px] ${f.state === 'OPEN' && f.dueDate && f.dueDate < today ? 'text-red-700' : 'text-ink-500'}`}>{f.state === 'OPEN' ? dueLabel(f.dueDate, today) : 'Done'}</span></span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-600"><span className="shrink-0 text-ink-500"><ActionIcon action={actionOf(f)} size={12} /></span><span className="truncate">{followUpLabel(f)}</span></span>
            {showFo && f.fo ? <span className="mt-0.5 block truncate text-[11.5px] text-ink-500">FO {f.fo.name}</span> : null}
          </span>
        </Link>
      </li>;
    })}</ul>
  </div>;
}

type PanelProps = { item: FollowUpRow; account: AccountView | null; today: string; timezone: string; nextUrl: string; nextWorkingDay: string; mayWork: boolean; whyNot?: string | null; workingDays?: number[] };

/** An open follow-up: what and why, for LinkedIn the account to use and the Console link, and Done / Snooze / Not needed. */
export function LinkedInFollowUpPanel({ item: f, account, today, timezone, nextUrl, nextWorkingDay, mayWork, whyNot = null, workingDays = [] }: PanelProps) {
  const { name, who, profileKey } = followUpSubject(f);
  const ref = refOf(f);
  const open = f.state === 'OPEN';
  const overdue = open && f.dueDate !== null && f.dueDate < today;
  const email = f.kind === 'EMAIL_REPLY';
  const consoleHref = email ? null : consoleProfileLink(f.accountId, profileKey);
  const resendHeld = f.kind === 'RESEND' && account?.atLimit;
  const closesWhen = email ? 'It closes by itself when Cadence sees an email to them go out.' : f.kind === 'MESSAGE' ? 'It closes by itself when the Console sees a message to them go out.' : f.kind === 'WITHDRAW' ? 'It closes by itself when the Console sees the request withdrawn, or if they accept first.' : 'It closes by itself when the Console sees the request sent.';
  return <Surface flush>
    <div className="flex items-start gap-3 rounded-t-[inherit] bg-brand-900 px-5 py-3.5 text-white">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-[#d5e9ad]"><ActionIcon action={actionOf(f)} size={16} /></span>
      <div className="min-w-0 flex-1">
        <span className="text-[12px] text-brand-200">{email ? 'Reply' : 'LinkedIn task'}</span>
        <div className="mt-1 break-words text-[19px] font-semibold leading-snug tracking-[-0.01em]">{followUpLabel(f)}</div>
      </div>
    </div>
    <header className="border-b border-line bg-gradient-to-r from-brand-50/70 to-white p-5">
      <div className="mb-4 flex items-center gap-3"><Avatar name={name} shape="circle" size={44} /><div>{ref ? <Link href={subjectHref(ref)} className="text-xl font-semibold tracking-tight hover:text-brand-700">{name}</Link> : <span className="text-xl font-semibold tracking-tight">{name}</span>}<div className="mt-1 text-sm text-ink-500">{who?.jobTitle ?? 'Title missing'}</div></div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{!f.person ? <Badge tone="sky">Cold contact</Badge> : null}<Badge tone={!open ? 'gray' : overdue ? 'red' : f.dueDate === today ? 'green' : 'blue'}>{!open ? (f.state === 'CANCELLED' ? 'Not needed' : 'Done') : overdue ? 'Overdue' : f.dueDate === today ? 'Due today' : 'Upcoming'}</Badge></div></div>
      <RecordFields items={[
        { label: 'Company', value: who?.companyName ?? null },
        { label: 'Why', value: followUpWhy(f, timezone) },
        ...(email ? [{ label: 'Email', value: who?.email ?? null }] : [{ label: 'From the account of', value: account ? `${account.name}${account.atLimit ? ' (at its weekly request limit)' : account.nearLimit ? ' (near its weekly request limit)' : ''}` : f.accountId }]),
        { label: 'Due', value: f.dueDate ? formatLocalDate(f.dueDate, 'long') : 'When someone takes it' },
        { label: 'Assigned to', value: f.fo?.name ?? 'Nobody yet' },
      ]} />
      {open ? <p className="mt-3 text-[12px] text-ink-500">{closesWhen}</p> : null}
    </header>
    {open ? <div className="space-y-3 p-5">
      {resendHeld ? <Notice tone="warn">{account!.name}&apos;s account sent {account!.invites} requests in the last 7 days, its limit. Wait a day or two before sending this one.</Notice> : null}
      {email ? null : consoleHref ? <a href={consoleHref} target="_blank" rel="noreferrer" className="btn-secondary inline-flex"><IconExternal size={15} /> Open in LinkedIn Console</a> : <Notice tone="info">Open {name} in the LinkedIn Console, from {account?.name ?? 'the account above'}, and do it there.</Notice>}
      {mayWork ? <LinkedInFollowUpControls id={f.id} nextUrl={nextUrl} nextWorkingDay={nextWorkingDay} subjectName={name} label={followUpLabel(f)} workingDays={workingDays} /> : whyNot ? <Notice tone="info">{whyNot}</Notice> : null}
    </div> : null}
  </Surface>;
}
