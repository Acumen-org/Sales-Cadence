import type { ReactNode } from 'react';
import { formatLocalDate } from '@/lib/dates';
import type { LinkedInSubjectView } from '@/lib/linkedin/subject-view';
import { IconExternal } from '@/components/icons';
import { Badge, Card } from '@/components/ui';

const TONE = { PENDING: 'amber', ACCEPTED: 'green', WITHDRAWN: 'gray' } as const;
const WORD = { PENDING: 'Request sent', ACCEPTED: 'Connected', WITHDRAWN: 'Withdrawn' } as const;

/**
 * LinkedIn: where each firm account stands with this person, as the LinkedIn Console reported it, and
 * the LinkedIn tasks still open. Cadence never acts on LinkedIn; Open in Console is where a teammate
 * does the work, by hand.
 */
export function LinkedInCard({ view, hasLink, addLink }: { view: LinkedInSubjectView; /** They have a profile link Cadence can match on. */ hasLink: boolean; /** How to add one, for a reader who may. */ addLink?: ReactNode }) {
  return <Card title="LinkedIn">
    {!hasLink ? <div className="space-y-2 border-b border-line p-4 text-[13px]">
      <p className="text-ink-600">Add their LinkedIn link so Cadence can see LinkedIn activity.</p>
      {addLink ?? null}
    </div> : null}
    {view.accounts.length ? <ul className="divide-y divide-line">
      {view.accounts.map((a) => <li key={a.accountId} className="space-y-2 px-4 py-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="font-medium text-ink-900">{a.accountName}</span>
          <Badge tone={TONE[a.status]}>{WORD[a.status]}</Badge>
          {a.consoleHref ? <a href={a.consoleHref} target="_blank" rel="noreferrer" className="btn-ghost btn-sm ml-auto"><IconExternal size={13} /> Open in Console</a> : null}
        </div>
        <div className="text-ink-700">{a.statusLine}{a.resendLine ? ` · ${a.resendLine}` : ''}</div>
        {a.lastSent || a.lastReply ? <div className="text-[12.5px] text-ink-500">{[a.lastSent ? `Last message sent ${a.lastSent}` : null, a.lastReply ? `Last reply ${a.lastReply}` : null].filter(Boolean).join(' · ')}</div> : null}
        {a.tasks.length ? <ul className="space-y-1">
          {a.tasks.map((t) => <li key={t.id} className="flex flex-wrap items-center gap-x-2 text-[12.5px]">
            <span className="font-medium text-ink-800">{t.label}</span>
            {t.dueDate ? <span className={t.overdue ? 'text-red-700' : 'text-ink-500'}>due {formatLocalDate(t.dueDate)}{t.overdue ? ' (overdue)' : ''}</span> : null}
            <span className={t.owner ? 'text-ink-500' : 'text-amber-700'}>· {t.owner ?? 'Needs an owner'}</span>
          </li>)}
        </ul> : null}
      </li>)}
    </ul> : hasLink ? <p className="p-4 text-[13px] text-ink-500">No LinkedIn activity seen yet.</p> : null}
  </Card>;
}
