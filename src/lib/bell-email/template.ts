import { WORDMARK_DARK, WORDMARK_LIGHT, type Wordmark } from './wordmark';

/*
 * The bell by email (owner, 21 Nov 2026: "a nice html email that shows the contents and links it to
 * Cadence"). Tables and inline styles, so Outlook, Gmail and phones draw it the same; 600px wide.
 * Every item links to the thing in Cadence.
 *
 * The look is "Option A, a clean letter" (owner, 23 Nov 2026): the Cadence wordmark large at the
 * top, then each item as its own section with a button. Three rules keep it right in every mail app:
 *   - Sizes are written out (font-size, font-weight, line-height), never the `font` shorthand, which
 *     Outlook drops, taking every size with it.
 *   - Every surface is pure white. Outlook's dark mode re-tints any colour we give a background, but
 *     turns white into its own dark grey, cleanly.
 *   - Dark mode changes text and line colours only, and swaps the wordmark for the app's white one:
 *     by the media query (Apple Mail, iOS, Outlook for Mac) and by the attributes Outlook on the web
 *     and the new Outlook put on what they recolour ([data-ogsc] / [data-ogsb], descendant form only).
 */

export type EmailItem = { kind: string; name: string; company: string | null; title: string; detail: string | null; href: string | null; linkLabel: string; at: Date };
export type EmailExtras = { approvalsWaiting?: number; crmReplies?: number };
/** A picture sent inside the email, shown where the html says cid:<id>. */
export type InlineImage = { id: string; contentType: 'image/png'; base64: string };
export type RenderedEmail = { subject: string; html: string; text: string; images: InlineImage[] };

type Tone = 'amber' | 'red' | 'green' | 'blue' | 'grey';
/** Label colours: on white, then in dark mode. */
const TONES: Record<Tone, [string, string]> = {
  amber: ['#9a5b00', '#f2c46a'],
  red: ['#b42318', '#f6a8a8'],
  green: ['#1f6b57', '#8ad6b8'],
  blue: ['#1e4fa8', '#aac5f4'],
  grey: ['#4d5d58', '#c3cec9'],
};

const KIND_LABEL: Record<string, { label: string; tone: Tone }> = {
  meeting_approval: { label: 'Approval needed', tone: 'amber' },
  meeting_declined: { label: 'Meeting declined', tone: 'red' },
  meeting_added_back: { label: 'Meeting added back', tone: 'green' },
  meeting_kudos: { label: 'Cheer', tone: 'green' },
  reply: { label: 'Reply', tone: 'green' },
  bounce: { label: 'Bounced', tone: 'red' },
  possible_bounce: { label: 'Possible bounce', tone: 'amber' },
  compliance_alert: { label: 'Compliance', tone: 'red' },
  call_flag: { label: 'Call flagged', tone: 'amber' },
  health_alert: { label: 'Health check', tone: 'red' },
  campaign_launch_failed: { label: 'Campaign', tone: 'red' },
  campaign_published: { label: 'Campaign', tone: 'green' },
  campaign_back_to_draft: { label: 'Campaign', tone: 'amber' },
  next_step_suggestion: { label: 'Suggested next step', tone: 'blue' },
  move_finished: { label: 'Moved to the CRM', tone: 'green' },
  retention_warning: { label: 'Cold outreach', tone: 'amber' },
};
const kindOf = (k: string) => KIND_LABEL[k] ?? { label: 'Update', tone: 'grey' as Tone };

/** Light colours, inline; their dark partners, by class. */
const C = { ink: '#16302a', text: '#2b3c39', muted: '#5f6e69', line: '#e3e8e5', brand: '#1f6b57' };
const D = { page: '#1f2422', ink: '#f1f5f3', text: '#d9e1de', muted: '#a9b6b1', line: '#3b4541', brand: '#7fd3b3' };

function darkRules(sel: (attr: 'c' | 'b', cls: string) => string): string {
  const rules: string[] = [];
  const text = (cls: string, v: string) => rules.push(`${sel('c', cls)}{color:${v}!important}`);
  const line = (cls: string, v: string) => rules.push(`${sel('b', cls)}{border-color:${v}!important}`);
  text('cd-ink', D.ink); text('cd-text', D.text); text('cd-muted', D.muted); text('cd-link', D.brand);
  for (const t of Object.keys(TONES) as Tone[]) text(`cd-${t}`, TONES[t][1]);
  line('cd-line', D.line); line('cd-accent', D.brand);
  // The app's own white wordmark in place of the evergreen one.
  rules.push(`${sel('c', 'cd-logo-light')}{display:none!important}`);
  rules.push(`${sel('c', 'cd-logo-dark')}{display:block!important;max-height:none!important;overflow:visible!important}`);
  return rules.join('\n');
}
/** Two blocks: Gmail drops a whole block it cannot read, so Outlook's rules stand apart. */
const DARK_STYLE = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.cd-page{background-color:${D.page}!important}
${darkRules((_, cls) => `.${cls}`)}
}
</style>
<style>
${darkRules((attr, cls) => `[data-ogs${attr}] .${cls}`)}
</style>`;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const abs = (appUrl: string, href: string | null) => `${appUrl.replace(/\/+$/, '')}${href && href.startsWith('/') ? href : '/home'}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const FONT = `-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
/** A text style written out in full, the way every mail app reads it. */
const type = (size: number, weight: number, lineHeight: number, colour: string, extra = '') =>
  `font-family:${FONT};font-size:${size}px;font-weight:${weight};line-height:${lineHeight}px;color:${colour};${extra}`;

function when(at: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
}

function button(href: string, label: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr><td bgcolor="${C.brand}" style="border-radius:10px;background-color:${C.brand}"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;border-radius:10px;${type(14, 600, 20, '#ffffff', 'text-decoration:none')}">${escapeHtml(label)} &rarr;</a></td></tr></table>`;
}

function itemHtml(i: EmailItem, appUrl: string, timezone: string) {
  const k = kindOf(i.kind);
  return `
    <tr><td class="cd-line" style="border-top:1px solid ${C.line};padding:22px 0 24px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><span class="cd-${k.tone}" style="${type(11, 700, 16, TONES[k.tone][0], 'letter-spacing:0.8px;text-transform:uppercase')}">&#9679;&nbsp; ${escapeHtml(k.label)}</span></td>
        <td align="right" class="cd-muted" style="${type(12, 400, 16, C.muted)}">${escapeHtml(when(i.at, timezone))}</td>
      </tr></table>
      <div class="cd-ink" style="margin-top:10px;${type(17, 600, 24, C.ink)}">${escapeHtml(i.name)}${i.company ? `<span class="cd-muted" style="${type(17, 400, 24, C.muted)}"> · ${escapeHtml(i.company)}</span>` : ''}</div>
      <div class="cd-text" style="margin-top:4px;${type(15, 400, 23, C.text)}">${escapeHtml(i.title)}</div>
      ${i.detail ? `<div class="cd-muted" style="margin-top:6px;${type(14, 400, 21, C.muted)}">${escapeHtml(clip(i.detail, 600))}</div>` : ''}
      ${button(abs(appUrl, i.href), i.linkLabel || 'Open in Cadence')}
    </td></tr>`;
}

/** The wordmark: light by default; the dark one waits hidden until a dark mode rule shows it. */
function wordmarkHtml(src: (w: Wordmark) => string) {
  const img = (w: Wordmark) => `<img src="${src(w)}" width="${w.width}" height="${w.height}" alt="cadence." style="display:block;border:0;outline:none;width:${w.width}px;height:${w.height}px;${type(36, 600, 40, C.brand)}">`;
  return `<div class="cd-logo-light">${img(WORDMARK_LIGHT)}</div><!--[if !mso]><!--><div class="cd-logo-dark" style="display:none;max-height:0;overflow:hidden;mso-hide:all">${img(WORDMARK_DARK)}</div><!--<![endif]-->`;
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

/**
 * One email: urgent items as they need someone, or the morning summary. `images: 'inline'` puts the
 * wordmark in the html itself (for a preview in a page); by default it is sent alongside (cid:).
 */
export function renderBellEmail(opts: { kind: 'instant' | 'digest' | 'test'; firstName: string; items: EmailItem[]; extras?: EmailExtras; appUrl: string; timezone: string; images?: 'attached' | 'inline' }): RenderedEmail {
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
  const linkStyle = type(15, 600, 23, C.brand, 'text-decoration:none');
  const waiting: string[] = [];
  if (extras.approvalsWaiting) waiting.push(`<a href="${escapeHtml(abs(appUrl, '/meetings/approval'))}" class="cd-link" style="${linkStyle}">${extras.approvalsWaiting} meeting${extras.approvalsWaiting === 1 ? '' : 's'} waiting for your approval</a>`);
  if (extras.crmReplies) waiting.push(`<a href="${escapeHtml(abs(appUrl, '/home'))}" class="cd-link" style="${linkStyle}">${extras.crmReplies} repl${extras.crmReplies === 1 ? 'y' : 'ies'} from your CRM contacts</a>`);
  const inline = opts.images === 'inline';
  const src = (w: Wordmark) => (inline ? `data:image/png;base64,${w.png}` : `cid:${w.id}`);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(subject)}</title>
${DARK_STYLE}
</head>
<body class="cd-page" style="margin:0;padding:0;background-color:#ffffff">
<div style="display:none;max-height:0;overflow:hidden;color:#ffffff">${escapeHtml(n ? items.map((i) => i.title).join(' · ').slice(0, 140) : intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="cd-page" style="background-color:#ffffff;color:${C.ink}"><tr><td align="center" style="padding:36px 20px 40px 20px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
    <tr><td style="padding:0 0 26px 0">${wordmarkHtml(src)}</td></tr>
    <tr><td class="cd-ink" style="${type(22, 600, 30, C.ink)}">Hi ${escapeHtml(opts.firstName)},</td></tr>
    <tr><td class="cd-muted" style="padding:6px 0 22px 0;${type(15, 400, 23, C.muted)}">${escapeHtml(intro)}</td></tr>
    ${waiting.length ? `<tr><td style="padding:0 0 26px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="cd-accent" style="border-left:3px solid ${C.brand};padding:4px 0 4px 14px;${type(15, 400, 23, C.text)}"><span class="cd-text">Waiting for you:</span> ${waiting.join(' <span class="cd-muted">·</span> ')}</td></tr></table></td></tr>` : ''}
    ${items.map((i) => itemHtml(i, appUrl, timezone)).join('')}
    <tr><td class="cd-line cd-muted" style="border-top:1px solid ${C.line};padding:20px 0 0 0;${type(12, 400, 19, C.muted)}">You get these because they are in your bell in Cadence. Only what you may see is sent. <a href="${escapeHtml(abs(appUrl, '/email-preferences'))}" class="cd-link" style="color:${C.brand}">Choose how Cadence emails you</a>.</td></tr>
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
  const images: InlineImage[] = inline ? [] : [WORDMARK_LIGHT, WORDMARK_DARK].map((w) => ({ id: w.id, contentType: 'image/png', base64: w.png }));
  return { subject, html, text, images };
}
