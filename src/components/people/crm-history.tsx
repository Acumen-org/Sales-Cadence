import { presentNoteBody } from '@/lib/crm-text';
import { crmEmailHtml } from '@/lib/rich-text';
import Link from 'next/link';
import clsx from 'clsx';
import { getTwentyClient } from '@/lib/twenty';
import { prisma } from '@/lib/db';
import { classifyMessage } from '@/lib/engine/matching';
import { formatInstant } from '@/lib/dates';
import { getSettings } from '@/lib/settings';
import { cleanNote, cleanTitle } from '@/lib/feed';
import type { TwentyMessage } from '@/lib/twenty/types';
import { Badge, Card, EmptyState } from '@/components/ui';

type Props = { personId: string; timezone: string; baseHref: string; notesAfter?: string; emailsAfter?: string; /** Emails and notes are separate tabs on the person page; the task brief shows both. */ show?: 'emails' | 'notes' | 'both' };

/**
 * Received or sent is the first thing to know about an email, so each message says it in words and
 * in colour: green for what came in, blue for what went out. The direction rule is the
 * engine's own (`classifyMessage`): sent by one of our users is outbound, sent by a person is inbound.
 */
const DIRECTION = {
  inbound: { label: 'Received', tone: 'green' as const, edge: 'border-l-emerald-400' },
  outbound: { label: 'Sent', tone: 'sky' as const, edge: 'border-l-sky-400' },
  unknown: { label: 'Email', tone: 'gray' as const, edge: 'border-l-line' },
};

const plain = (text: string | null) => (text ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const bareSubject = (s: string | null) => (s ?? '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim() || 'No subject';
const NOTE_OPEN_UNDER = 500;

/**
 * Full CRM email and note content, with cursor navigation through older records. Emails are grouped
 * into conversations (owner, 13 Nov 2026: one long run of open emails read as one), oldest first
 * inside each, with only the latest open; the rest show who wrote and a first line, and open on a click.
 */
export async function CrmHistory({ personId, timezone, baseHref, notesAfter, emailsAfter, show = 'both' }: Props) {
  const client = await getTwentyClient();
  const [notesResult, emailsResult, users, settings] = await Promise.all([
    show !== 'emails' ? client.listNotes({ personId, limit: 25, after: notesAfter }).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })) : null,
    show !== 'notes' ? client.listMessages({ personId, limit: 25, after: emailsAfter }).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })) : null,
    prisma.user.findMany({ select: { id: true, name: true, email: true, twentyMemberId: true, aliases: true } }),
    getSettings(),
  ]);
  const notes = notesResult?.ok ? notesResult.value : null;
  const emails = emailsResult?.ok ? emailsResult.value : null;
  const pageHref = (key: 'crmNotes' | 'crmEmails', cursor?: string | null) => {
    const url = new URL(baseHref, 'http://cadence.local');
    if (notesAfter) url.searchParams.set('crmNotes', notesAfter);
    if (emailsAfter) url.searchParams.set('crmEmails', emailsAfter);
    if (cursor) url.searchParams.set(key, cursor); else url.searchParams.delete(key);
    return `${url.pathname}${url.search}#${key}`;
  };
  // Conversations, the newest first; a message with no thread is a conversation of its own.
  const threads: { id: string; messages: TwentyMessage[] }[] = [];
  for (const m of emails?.items ?? []) {
    const id = m.threadId ?? m.id;
    const t = threads.find((x) => x.id === id);
    if (t) t.messages.push(m); else threads.push({ id, messages: [m] });
  }
  for (const t of threads) t.messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const directionOf = (m: TwentyMessage) => DIRECTION[classifyMessage(m, users).direction];
  const received = (emails?.items ?? []).filter((m) => classifyMessage(m, users).direction === 'inbound').length;
  const who = (list: TwentyMessage['participants']) => list.map((p) => p.displayName || p.handle).filter(Boolean).join(', ');

  return <div className="space-y-3">
    {show !== 'notes' ? <div id="crmEmails"><Card title="Emails" actions={emails?.items.length ? <span className="text-[12px] text-ink-500">{[`${emails.items.length} email${emails.items.length === 1 ? '' : 's'}`, threads.length < emails.items.length ? `${threads.length} conversations` : null, received ? `${received} received` : null, emails.items.length - received ? `${emails.items.length - received} sent` : null].filter(Boolean).join(' · ')}</span> : null}>
      {!emails ? <div role="status" className="p-4 text-sm text-amber-800">Email history is temporarily unavailable.</div> : !emails.items.length ? <EmptyState title="No emails yet" hint="Emails the CRM's mailbox sync saw with this person show here." /> : <div className="space-y-3 p-4">{threads.map((t) => {
        const last = t.messages[t.messages.length - 1];
        const people = [...new Set(t.messages.flatMap((m) => m.participants.filter((p) => p.role === 'from' || p.role === 'to').map((p) => p.displayName || p.handle)))];
        return <article key={t.id} className="overflow-hidden rounded-xl border border-line bg-white">
          <header className="flex items-start gap-3 border-b border-line bg-canvas/70 px-4 py-3">
            <div className="min-w-0 flex-1">
              <h3 className="break-words text-[14px] font-semibold text-ink-900">{bareSubject(t.messages[0].subject)}</h3>
              <div className="mt-0.5 truncate text-[12px] text-ink-500">{t.messages.length === 1 ? '1 message' : `${t.messages.length} messages`} · {people.join(', ')}</div>
            </div>
            <time dateTime={last.receivedAt} className="shrink-0 text-[12px] text-ink-600">{formatInstant(new Date(last.receivedAt), timezone)}</time>
          </header>
          <ol className="divide-y divide-line">{t.messages.map((m) => {
            const d = directionOf(m);
            const from = m.participants.filter((p) => p.role === 'from');
            const to = m.participants.filter((p) => p.role === 'to');
            const copies = m.participants.filter((p) => p.role === 'cc' || p.role === 'bcc');
            return <li key={m.id}><details open={m === last} className={clsx('group border-l-[3px]', d.edge)}>
              <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-2.5 hover:bg-canvas/50">
                <Badge tone={d.tone}>{d.label}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-ink-800"><span className="font-medium">{who(from) || 'Sender unavailable'}</span>{to.length ? <span className="text-ink-500"> to {who(to)}</span> : null}</div>
                  <div className="truncate text-[12.5px] text-ink-500 group-open:hidden">{plain(m.text).slice(0, 180) || 'No text'}</div>
                </div>
                <time dateTime={m.receivedAt} className="shrink-0 text-[12px] text-ink-500">{formatInstant(new Date(m.receivedAt), timezone)}</time>
              </summary>
              <div className="px-4 pb-4">
                {copies.length ? <div className="mb-2 text-[12px] text-ink-500">Copied: {copies.map((p) => p.displayName ? `${p.displayName} <${p.handle}>` : p.handle).join(', ')}</div> : null}
                <div className="max-w-[75ch] whitespace-normal break-words text-[13px] leading-6 text-ink-800 [&_a]:text-brand-700 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-ink-500 [&_img]:max-w-full [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: crmEmailHtml(m.text || 'The CRM has no email body for this message.') }} />
              </div>
            </details></li>;
          })}</ol>
        </article>;
      })}</div>}
      {emails && (emailsAfter || emails.hasNextPage) ? <div className="flex justify-between gap-2 border-t border-line p-3">{emailsAfter ? <Link href={pageHref('crmEmails')} className="btn-secondary btn-sm">Latest emails</Link> : <span />}{emails.hasNextPage && emails.endCursor ? <Link href={pageHref('crmEmails', emails.endCursor)} className="btn-secondary btn-sm">Older emails</Link> : null}</div> : null}
    </Card></div> : null}
    {show !== 'emails' ? <div id="crmNotes"><Card title="Notes" actions={notes?.items.length ? <span className="text-[12px] text-ink-500">From the CRM</span> : null}>
      {!notes ? <div role="status" className="p-4 text-sm text-amber-800">CRM notes are temporarily unavailable.</div> : !notes.items.length ? <EmptyState title="No notes yet" /> : <div className="space-y-3 p-4">{notes.items.map((note) => {
        const mine = (note.title ?? '').startsWith(settings.matching.cadencePrefix);
        const { body, fields } = cleanNote(presentNoteBody(note.bodyMarkdown));
        const long = (body ?? '').length > NOTE_OPEN_UNDER;
        return <details open={!long} key={note.id} className="group overflow-hidden rounded-xl border border-line bg-white">
          <summary className="flex cursor-pointer list-none items-start gap-3 bg-canvas/70 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="break-words font-medium text-ink-900">{cleanTitle(note.title, settings.matching.cadencePrefix)}</span>{mine ? <Badge tone="gray">From Cadence</Badge> : null}</div>
              <div className="mt-0.5 text-[12px] text-ink-500">{note.createdByName ?? 'Someone'}{long ? <span className="group-open:hidden"> · {plain(body).slice(0, 120)}…</span> : null}</div>
            </div>
            <time dateTime={note.createdAt} className="shrink-0 text-[12px] text-ink-600">{formatInstant(new Date(note.createdAt), timezone)}</time>
          </summary>
          <div className="space-y-2 border-t border-line/70 px-4 pb-4 pt-3">
            {fields.length ? <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">{fields.map((f) => <span key={f.label + f.value}><span className="text-ink-500">{f.label}:</span> <span className="text-ink-800">{f.value}</span></span>)}</div> : null}
            {body ? <div className="max-w-[75ch] whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-800">{body}</div> : !fields.length ? <div className="text-[13px] text-ink-500">No note body</div> : null}
          </div>
        </details>;
      })}</div>}
      {notes && (notesAfter || notes.hasNextPage) ? <div className="flex justify-between gap-2 border-t border-line p-3">{notesAfter ? <Link href={pageHref('crmNotes')} className="btn-secondary btn-sm">Latest notes</Link> : <span />}{notes.hasNextPage && notes.endCursor ? <Link href={pageHref('crmNotes', notes.endCursor)} className="btn-secondary btn-sm">Older notes</Link> : null}</div> : null}
    </Card></div> : null}
  </div>;
}
