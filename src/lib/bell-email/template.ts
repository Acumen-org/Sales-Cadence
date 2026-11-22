/*
 * The bell by email (owner, 21 Nov 2026: "a nice html email that shows the contents and links it to
 * Cadence"). Tables and inline styles, so Outlook, Gmail and phones draw it the same; 600px wide,
 * readable without images (there are none). Every item links to the thing in Cadence.
 */

export type EmailItem = { kind: string; name: string; company: string | null; title: string; detail: string | null; href: string | null; linkLabel: string; at: Date };
export type EmailExtras = { approvalsWaiting?: number; crmReplies?: number };
export type RenderedEmail = { subject: string; html: string; text: string };

const KIND_LABEL: Record<string, { label: string; colour: string; bg: string }> = {
  meeting_approval: { label: 'Approval needed', colour: '#92400e', bg: '#fef3c7' },
  meeting_declined: { label: 'Meeting declined', colour: '#991b1b', bg: '#fee2e2' },
  meeting_added_back: { label: 'Meeting added back', colour: '#1d4a3f', bg: '#d8eee5' },
  meeting_kudos: { label: 'Cheer', colour: '#92400e', bg: '#fef3c7' },
  reply: { label: 'Reply', colour: '#1d4a3f', bg: '#d8eee5' },
  bounce: { label: 'Bounced', colour: '#991b1b', bg: '#fee2e2' },
  possible_bounce: { label: 'Possible bounce', colour: '#92400e', bg: '#fef3c7' },
  compliance_alert: { label: 'Compliance', colour: '#991b1b', bg: '#fee2e2' },
  call_flag: { label: 'Call flagged', colour: '#92400e', bg: '#fef3c7' },
  health_alert: { label: 'Health check', colour: '#991b1b', bg: '#fee2e2' },
  campaign_launch_failed: { label: 'Campaign', colour: '#991b1b', bg: '#fee2e2' },
  campaign_published: { label: 'Campaign', colour: '#1d4a3f', bg: '#d8eee5' },
  campaign_back_to_draft: { label: 'Campaign', colour: '#92400e', bg: '#fef3c7' },
  next_step_suggestion: { label: 'Suggested next step', colour: '#1e3a8a', bg: '#dbeafe' },
  move_finished: { label: 'Moved to the CRM', colour: '#1d4a3f', bg: '#d8eee5' },
  retention_warning: { label: 'Cold outreach', colour: '#92400e', bg: '#fef3c7' },
};
const kindOf = (k: string) => KIND_LABEL[k] ?? { label: 'Update', colour: '#40514d', bg: '#eef2ef' };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const abs = (appUrl: string, href: string | null) => `${appUrl.replace(/\/+$/, '')}${href && href.startsWith('/') ? href : '/home'}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function when(at: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
}

function itemHtml(i: EmailItem, appUrl: string, timezone: string) {
  const k = kindOf(i.kind);
  const who = `${escapeHtml(i.name)}${i.company ? `<span style="color:#65736e;font-weight:400"> · ${escapeHtml(i.company)}</span>` : ''}`;
  return `
  <tr><td style="padding:0 0 12px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e8e2;border-radius:12px;border-collapse:separate">
      <tr><td style="padding:16px 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font:600 11px/16px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${k.bg};color:${k.colour}">${escapeHtml(k.label)}</span></td>
          <td align="right" style="font:400 12px/16px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#73817a">${escapeHtml(when(i.at, timezone))}</td>
        </tr></table>
        <div style="margin-top:10px;font:600 14px/20px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#192b29">${who}</div>
        <div style="margin-top:4px;font:400 14px/21px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2b3c39">${escapeHtml(i.title)}</div>
        ${i.detail ? `<div style="margin-top:6px;font:400 13px/19px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#576661">${escapeHtml(clip(i.detail, 600))}</div>` : ''}
        <div style="margin-top:14px"><a href="${escapeHtml(abs(appUrl, i.href))}" style="display:inline-block;padding:8px 14px;border-radius:9px;background:#24735e;color:#ffffff;text-decoration:none;font:600 13px/18px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${escapeHtml(i.linkLabel || 'Open in Cadence')} &rarr;</a></div>
      </td></tr>
    </table>
  </td></tr>`;
}

/** A subject that says what to do first, then what it is about. */
function shortSubject(i: EmailItem): string {
  switch (i.kind) {
    case 'meeting_approval': return `Approve or decline: ${i.name}`;
    case 'meeting_declined': return `Meeting declined: ${i.name}`;
    case 'reply': return `${i.name} replied`;
    case 'bounce': return `Email bounced: ${i.name}`;
    case 'possible_bounce': return `Possible bounce: ${i.name}`;
    case 'compliance_alert': return `Compliance alert: ${i.name}`;
    case 'call_flag': return `Call flagged: ${i.name}`;
    case 'campaign_launch_failed': return `Campaign did not start: ${i.name}`;
    default: return `${i.name}: ${i.title}`;
  }
}

/** One email: urgent items as they need someone, or the morning summary. */
export function renderBellEmail(opts: { kind: 'instant' | 'digest' | 'test'; firstName: string; items: EmailItem[]; extras?: EmailExtras; appUrl: string; timezone: string }): RenderedEmail {
  const { items, appUrl, timezone } = opts;
  const extras = opts.extras ?? {};
  const n = items.length;
  const subject = opts.kind === 'test'
    ? 'Cadence emails are working'
    : opts.kind === 'instant'
      ? n === 1 ? clip(shortSubject(items[0]), 110) : `${n} things need you in Cadence`
      : `Your Cadence summary: ${n ? `${n} update${n === 1 ? '' : 's'}` : 'what is waiting'}`;
  const intro = opts.kind === 'test'
    ? 'This is a test from Settings. This is how Cadence emails look.'
    : opts.kind === 'instant'
      ? n === 1 ? 'This needs you in Cadence.' : 'These need you in Cadence.'
      : 'Here is what came in since your last summary.';
  const waiting: string[] = [];
  if (extras.approvalsWaiting) waiting.push(`<a href="${escapeHtml(abs(appUrl, '/meetings/approval'))}" style="color:#24735e;font-weight:600;text-decoration:none">${extras.approvalsWaiting} meeting${extras.approvalsWaiting === 1 ? '' : 's'} waiting for your approval</a>`);
  if (extras.crmReplies) waiting.push(`<a href="${escapeHtml(abs(appUrl, '/home'))}" style="color:#24735e;font-weight:600;text-decoration:none">${extras.crmReplies} repl${extras.crmReplies === 1 ? 'y' : 'ies'} from your CRM contacts</a>`);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f6f4">
<div style="display:none;max-height:0;overflow:hidden;color:#f5f6f4">${escapeHtml(n ? items.map((i) => i.title).join(' · ').slice(0, 140) : intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f4"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
    <tr><td style="padding:0 6px 14px 6px;font:700 20px/24px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#24735e;letter-spacing:-0.02em">cadence<span style="color:#82c4ac">.</span></td></tr>
    <tr><td style="background:#ffffff;border-radius:16px;padding:26px 24px 14px 24px;border:1px solid #e3e8e2">
      <div style="font:600 18px/26px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#192b29">Hi ${escapeHtml(opts.firstName)},</div>
      <div style="margin:4px 0 18px 0;font:400 14px/21px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#576661">${escapeHtml(intro)}</div>
      ${waiting.length ? `<div style="margin:0 0 16px 0;padding:12px 14px;border-radius:12px;background:#edf7f3;font:400 13px/20px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d4a3f">Waiting for you: ${waiting.join(' · ')}</div>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map((i) => itemHtml(i, appUrl, timezone)).join('')}</table>
    </td></tr>
    <tr><td style="padding:16px 8px 0 8px;font:400 12px/18px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#73817a">
      You get these because they are in your bell in Cadence. Only what you may see is sent.
      <a href="${escapeHtml(abs(appUrl, '/email-preferences'))}" style="color:#24735e">Choose how Cadence emails you</a>.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    `Hi ${opts.firstName},`, '', intro, '',
    ...(extras.approvalsWaiting ? [`Waiting for your approval: ${extras.approvalsWaiting} meeting(s): ${abs(appUrl, '/meetings/approval')}`] : []),
    ...(extras.crmReplies ? [`Replies from your CRM contacts: ${extras.crmReplies}: ${abs(appUrl, '/home')}`] : []),
    ...items.flatMap((i) => [`- ${kindOf(i.kind).label}: ${i.name}${i.company ? ` (${i.company})` : ''}`, `  ${i.title}`, ...(i.detail ? [`  ${clip(i.detail, 300)}`] : []), `  ${abs(appUrl, i.href)}`, '']),
    `Choose how Cadence emails you: ${abs(appUrl, '/email-preferences')}`,
  ].join('\n');
  return { subject, html, text };
}
