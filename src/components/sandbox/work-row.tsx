'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { ActionButton } from '@/components/action-form';
import { ActionIcon } from '@/components/icons';
import { CallButton } from '@/components/calls/call-button';
import { Badge } from '@/components/ui';
import { completeTaskAction, skipTaskAction } from '@/lib/actions/tasks';
import { completeNextActionAction } from '@/lib/actions/next-actions';
import { coldRef, subjectHref } from '@/lib/subject';

type Props = {
  kind: 'step' | 'next';
  id: string;
  contact: { id: string; name: string; firm: string | null; phone: string | null };
  label: string;
  action: string;
  channelLabel: string;
  due: string;
  dueState: 'overdue' | 'today' | 'upcoming';
  campaign: string | null;
  fo: string;
  callTemplate: string;
  gate: { blocked: string | null; warning: string | null } | null;
  skipReasons: { key: string; label: string }[];
  mayWork: boolean;
  /** "Email bounced" or "Possible bounce" on the contact (N097). */
  warning?: string | null;
  /** On an email item: whether it closes itself when the rep sends from Outlook (N088). */
  closeWords?: string | null;
};

/**
 * One piece of sandbox work: a campaign step or a next action. A call opens the dialpad and ends
 * in the post-call form, which closes the step; email and LinkedIn steps are marked done here.
 */
export function WorkRow({ kind, id, contact, label, action, channelLabel, due, dueState, campaign, fo, callTemplate, gate, skipReasons, mayWork, warning = null, closeWords = null }: Props) {
  return <li className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
    <span className="text-ink-500"><ActionIcon action={action} size={15} /></span>
    <span className="min-w-0 flex-1">
      <Link href={subjectHref(coldRef(contact.id))} className="text-ink-900 hover:text-brand-700">{contact.name}</Link>
      <span className="text-ink-500">{contact.firm ? ` · ${contact.firm}` : ''}</span>
      {warning ? <Badge tone="amber" className="ml-2">{warning}</Badge> : null}
      <span className="block truncate text-ink-600">{label}{campaign ? ` · ${campaign}` : ''} · {fo}</span>
      {closeWords && action === 'EMAIL' ? <span className="block text-[12px] text-ink-500">{closeWords}</span> : null}
    </span>
    <span className={clsx('w-24 shrink-0 tabular-nums', dueState === 'overdue' ? 'text-red-700' : dueState === 'today' ? 'text-ink-900' : 'text-ink-500')}>{due}</span>
    {mayWork ? <span className="flex shrink-0 items-center gap-1.5">
      {action === 'CALL' && contact.phone ? <CallButton phone={contact.phone} template={callTemplate} taskId={kind === 'step' ? id : null} nextActionId={kind === 'next' ? id : null} sandboxContactId={contact.id} blocked={gate?.blocked} warning={gate?.warning} className="btn-secondary btn-sm" /> : null}
      {kind === 'step' && action !== 'CALL' ? <ActionButton action={completeTaskAction} payload={{ taskId: id }} refresh>Done</ActionButton> : null}
      {/* B161: a call closes with its call and its form, never with Done. */}
      {/* B183: a booked meeting is no call to make: it is marked held. */}
      {kind === 'next' && action !== 'CALL' ? <ActionButton action={completeNextActionAction} payload={{ id }} refresh>{action === 'MEETING' ? 'Meeting held' : 'Done'}</ActionButton> : null}
      {kind === 'step' ? <select aria-label={`Skip ${channelLabel}`} className="!py-1 text-[12px]" defaultValue="" onChange={async (e) => { const reason = e.target.value; e.target.value = ''; if (!reason) return; const fd = new FormData(); fd.set('taskId', id); fd.set('reasonKey', reason); await skipTaskAction(fd); window.location.reload(); }}><option value="" disabled>Skip</option>{skipReasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select> : null}
    </span> : null}
  </li>;
}
