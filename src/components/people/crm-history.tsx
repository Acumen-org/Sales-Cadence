import { cleanRichText, plainToHtml } from '@/lib/rich-text';
import Link from 'next/link';
import { getTwentyClient } from '@/lib/twenty';
import { prisma } from '@/lib/db';
import { classifyMessage } from '@/lib/engine/matching';
import { formatInstant } from '@/lib/dates';
import { ActionIcon } from '@/components/icons';
import { Badge, Card, EmptyState } from '@/components/ui';

type Props = { personId: string; timezone: string; baseHref: string; notesAfter?: string; emailsAfter?: string };

/**
 * Received or sent is the first thing to know about an email, so it is what the card is made of:
 * a green edge for what came in, a red one for what went out, each message in its own frame so
 * two of them can never read as one. The direction rule is the engine's own (`classifyMessage`),
 * not a second opinion: sent by one of our users is outbound, sent by a person is inbound.
 */
const DIRECTION = {
  inbound: { label: 'Received', tone: 'green' as const, frame: 'border-emerald-200', edge: 'border-l-emerald-500', head: 'bg-emerald-50/70' },
  outbound: { label: 'Sent', tone: 'red' as const, frame: 'border-red-200', edge: 'border-l-red-400', head: 'bg-red-50/60' },
  unknown: { label: 'Email', tone: 'gray' as const, frame: 'border-line', edge: 'border-l-ink-300', head: 'bg-canvas' },
};

/** Full CRM email and note content, with cursor navigation through older records. */
export async function CrmHistory({ personId, timezone, baseHref, notesAfter, emailsAfter }: Props) {
  const client = await getTwentyClient();
  const [notesResult, emailsResult, users] = await Promise.all([
    client.listNotes({ personId, limit: 25, after: notesAfter }).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })),
    client.listMessages({ personId, limit: 25, after: emailsAfter }).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })),
    prisma.user.findMany({ select: { id: true, name: true, email: true, twentyMemberId: true, aliases: true } }),
  ]);
  const notes = notesResult.ok ? notesResult.value : null;
  const emails = emailsResult.ok ? emailsResult.value : null;
  const pageHref = (key: 'crmNotes' | 'crmEmails', cursor?: string | null) => {
    const url = new URL(baseHref, 'http://cadence.local');
    if (notesAfter) url.searchParams.set('crmNotes', notesAfter);
    if (emailsAfter) url.searchParams.set('crmEmails', emailsAfter);
    if (cursor) url.searchParams.set(key, cursor); else url.searchParams.delete(key);
    return `${url.pathname}${url.search}#${key}`;
  };
  return <div className="space-y-3">
    <div id="crmEmails"><Card title="CRM emails" actions={<Badge tone="blue">Twenty</Badge>}>
      {!emails ? <div role="status" className="p-4 text-sm text-amber-800">Email history is temporarily unavailable.</div> : !emails.items.length ? <EmptyState title="No CRM emails" /> : <div className="space-y-3 p-4">{emails.items.map((message) => {
        const direction = DIRECTION[classifyMessage(message, users).direction];
        const senders = message.participants.filter((p) => p.role === 'from');
        const recipients = message.participants.filter((p) => p.role === 'to');
        const who = (list: typeof message.participants) => list.map((p) => p.displayName || p.handle).filter(Boolean).join(', ');

        return <details open key={message.id} className={`group overflow-hidden rounded-xl border border-l-[3px] ${direction.frame} ${direction.edge} bg-white`}>
          <summary className={`flex cursor-pointer list-none items-start gap-3 px-4 py-3 ${direction.head}`}>
            <ActionIcon action="EMAIL" size={16} className="mt-0.5 shrink-0 text-ink-500" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <Badge tone={direction.tone}>{direction.label}</Badge>
                <span className="truncate font-medium text-ink-900">{message.subject || 'No subject'}</span>
              </div>
              <div className="mt-1 truncate text-xs text-ink-500">
                {who(senders) || 'Sender unavailable'}
                {recipients.length ? <span className="text-ink-400"> → {who(recipients)}</span> : null}
              </div>
            </div>
            <time dateTime={message.receivedAt} className="shrink-0 text-xs text-ink-600">{formatInstant(new Date(message.receivedAt), timezone)}</time>
          </summary>
          <div className="border-t border-line/70 px-4 pb-4 pt-3">
            <dl className="grid gap-3 rounded-lg bg-canvas p-3 text-xs sm:grid-cols-2">{(['from', 'to', 'cc', 'bcc'] as const).map(role => {
              const participants = message.participants.filter(participant => participant.role === role);
              return participants.length ? <div key={role}><dt className="uppercase text-ink-500">{role}</dt><dd className="mt-1 break-words font-medium text-ink-900">{participants.map(participant => participant.displayName ? `${participant.displayName} <${participant.handle}>` : participant.handle).join(', ')}</dd></div> : null;
            })}</dl>
            <div className="mt-3 max-w-[70ch] whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-800 [&_a]:text-brand-700 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-ink-500 [&_img]:max-w-full [&_table]:block [&_table]:overflow-x-auto" dangerouslySetInnerHTML={{ __html: cleanRichText(message.text ? /<(?:p|div|br|html|table|a)\b/i.test(message.text) ? message.text : plainToHtml(message.text) : plainToHtml('The CRM has no email body for this message.')) }} />
          </div>
        </details>;
      })}</div>}
      {emails && (emailsAfter || emails.hasNextPage) ? <div className="flex justify-between gap-2 border-t border-line p-3">{emailsAfter ? <Link href={pageHref('crmEmails')} className="btn-secondary btn-sm">Latest emails</Link> : <span />}{emails.hasNextPage && emails.endCursor ? <Link href={pageHref('crmEmails', emails.endCursor)} className="btn-secondary btn-sm">Older emails</Link> : null}</div> : null}
    </Card></div>
    <div id="crmNotes"><Card title="CRM notes" actions={<Badge tone="blue">Twenty</Badge>}>
      {!notes ? <div role="status" className="p-4 text-sm text-amber-800">CRM notes are temporarily unavailable.</div> : !notes.items.length ? <EmptyState title="No CRM notes" /> : <div className="space-y-3 p-4">{notes.items.map((note) => <details open key={note.id} className="overflow-hidden rounded-xl border border-line bg-white">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 bg-canvas px-4 py-3"><div className="min-w-0 truncate font-medium text-ink-900">{note.title || 'Untitled note'}</div><time dateTime={note.createdAt} className="shrink-0 text-xs text-ink-600">{formatInstant(new Date(note.createdAt), timezone)}</time></summary>
        <div className="border-t border-line/70 px-4 pb-4 pt-3"><div className="max-w-[70ch] whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-800">{note.bodyMarkdown || 'No note body'}</div>{note.createdByName ? <div className="mt-3 border-t border-line pt-3 text-xs"><span className="text-ink-500">Author</span><span className="ml-2 font-medium text-ink-900">{note.createdByName}</span></div> : null}</div>
      </details>)}</div>}
      {notes && (notesAfter || notes.hasNextPage) ? <div className="flex justify-between gap-2 border-t border-line p-3">{notesAfter ? <Link href={pageHref('crmNotes')} className="btn-secondary btn-sm">Latest notes</Link> : <span />}{notes.hasNextPage && notes.endCursor ? <Link href={pageHref('crmNotes', notes.endCursor)} className="btn-secondary btn-sm">Older notes</Link> : null}</div> : null}
    </Card></div>
  </div>;
}
