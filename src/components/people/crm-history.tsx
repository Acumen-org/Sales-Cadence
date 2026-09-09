import Link from 'next/link';
import { getTwentyClient } from '@/lib/twenty';
import { formatInstant } from '@/lib/dates';
import { ActionIcon } from '@/components/icons';
import { Badge, Card, EmptyState } from '@/components/ui';

type Props = { personId: string; timezone: string; baseHref: string; notesAfter?: string; emailsAfter?: string };

/** Full CRM email and note content, with cursor navigation through older records. */
export async function CrmHistory({ personId, timezone, baseHref, notesAfter, emailsAfter }: Props) {
  const client = await getTwentyClient();
  const [notesResult, emailsResult] = await Promise.allSettled([
    client.listNotes({ personId, limit: 25, after: notesAfter }),
    client.listMessages({ personId, limit: 25, after: emailsAfter }),
  ]);
  const notes = notesResult.status === 'fulfilled' ? notesResult.value : null;
  const emails = emailsResult.status === 'fulfilled' ? emailsResult.value : null;
  const pageHref = (key: 'crmNotes' | 'crmEmails', cursor?: string | null) => {
    const url = new URL(baseHref, 'http://cadence.local');
    if (notesAfter) url.searchParams.set('crmNotes', notesAfter);
    if (emailsAfter) url.searchParams.set('crmEmails', emailsAfter);
    if (cursor) url.searchParams.set(key, cursor); else url.searchParams.delete(key);
    return `${url.pathname}${url.search}#${key}`;
  };
  return <div className="space-y-3">
    <div id="crmEmails"><Card title="CRM emails" actions={<Badge tone="blue">Twenty</Badge>}>
      {!emails ? <div role="status" className="p-4 text-sm text-amber-800">Email history is temporarily unavailable.</div> : !emails.items.length ? <EmptyState title="No CRM emails" /> : <div className="divide-y divide-line">{emails.items.map((message) => {
        const senders = message.participants.filter((p) => p.role === 'from');
        const recipients = message.participants.filter((p) => p.role !== 'from');
        return <details key={message.id} className="group p-4"><summary className="flex cursor-pointer list-none items-start gap-3"><ActionIcon action="EMAIL" size={16} className="mt-0.5 shrink-0 text-brand-700" /><div className="min-w-0 flex-1"><div className="font-semibold text-ink-900">{message.subject || 'No subject'}</div><div className="mt-1 text-xs font-semibold text-ink-700">{senders.map((p) => p.displayName || p.handle).join(', ') || 'Sender unavailable'}</div></div><time dateTime={message.receivedAt} className="shrink-0 text-xs font-semibold text-ink-800">{formatInstant(new Date(message.receivedAt), timezone)}</time></summary>
          <dl className="mt-3 space-y-2 rounded-lg bg-canvas p-3 text-xs"><div><dt className="text-ink-500">From</dt><dd className="mt-1 break-words font-semibold text-ink-900">{senders.map((p) => p.handle).join(', ') || 'Unavailable'}</dd></div><div><dt className="text-ink-500">To / cc</dt><dd className="mt-1 break-words font-semibold text-ink-900">{recipients.map((p) => p.handle).join(', ') || 'Unavailable'}</dd></div></dl>
          <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-ink-800">{message.text || 'The CRM has no email body for this message.'}</div>
        </details>;
      })}</div>}
      {emails && (emailsAfter || emails.hasNextPage) ? <div className="flex justify-between gap-2 border-t border-line p-3">{emailsAfter ? <Link href={pageHref('crmEmails')} className="btn-secondary btn-sm">Latest emails</Link> : <span />}{emails.hasNextPage && emails.endCursor ? <Link href={pageHref('crmEmails', emails.endCursor)} className="btn-secondary btn-sm">Older emails</Link> : null}</div> : null}
    </Card></div>
    <div id="crmNotes"><Card title="CRM notes" actions={<Badge tone="blue">Twenty</Badge>}>
      {!notes ? <div role="status" className="p-4 text-sm text-amber-800">CRM notes are temporarily unavailable.</div> : !notes.items.length ? <EmptyState title="No CRM notes" /> : <div className="divide-y divide-line">{notes.items.map((note) => <details key={note.id} className="p-4"><summary className="flex cursor-pointer list-none items-start justify-between gap-3"><div className="font-semibold text-ink-900">{note.title || 'Untitled note'}</div><time dateTime={note.createdAt} className="shrink-0 text-xs font-semibold text-ink-800">{formatInstant(new Date(note.createdAt), timezone)}</time></summary><div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-ink-800">{note.bodyMarkdown || 'No note body'}</div>{note.createdByName ? <div className="mt-3 border-t border-line pt-3 text-xs"><span className="text-ink-500">Author</span><strong className="ml-2 text-ink-900">{note.createdByName}</strong></div> : null}</details>)}</div>}
      {notes && (notesAfter || notes.hasNextPage) ? <div className="flex justify-between gap-2 border-t border-line p-3">{notesAfter ? <Link href={pageHref('crmNotes')} className="btn-secondary btn-sm">Latest notes</Link> : <span />}{notes.hasNextPage && notes.endCursor ? <Link href={pageHref('crmNotes', notes.endCursor)} className="btn-secondary btn-sm">Older notes</Link> : null}</div> : null}
    </Card></div>
  </div>;
}
