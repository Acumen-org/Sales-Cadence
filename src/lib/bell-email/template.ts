import { WORDMARK_DARK, WORDMARK_LIGHT, type Wordmark } from './wordmark';

/*
 * The bell by email (owner, 21 Nov 2026: "a nice html email that shows the contents and links it to
 * Cadence"). Tables and inline styles, so Outlook, Gmail and phones draw it the same; 600px wide.
 * Every item links to the thing in Cadence.
 *
 * The look is "Option A, a clean letter" (owner, 23 Nov 2026), on a sheet (24 Nov): the letter is a
 * filled sheet on a tinted page (white on pale green-grey; in dark mode a lifted dark sheet on a deeper
 * ground). Inside: the Cadence wordmark, a "Waiting for you" box in plain ink, then each item as its
 * own section split edge to edge, with a plain coloured label and a button. No arrows anywhere.
 * What keeps it right in every mail app:
 *   - Sizes are written out (font-size, font-weight, line-height), never the `font` shorthand, which
 *     Outlook drops, taking every size with it.
 *   - Every surface is two layers: an outer one with its light colour inline, and an inner one with
 *     no colour of its own. Dark mode colours both.
 *   - Apple Mail (and iOS, Outlook for Mac) gets its dark surfaces from the media query by attribute
 *     selectors ([class~=...]). The new Outlook reads that media query too, and re-tinted our dark
 *     page colour into the flat grey of the 23 and 24 Nov tests; Outlook renames classes, so it is
 *     meant to miss these selectors and see only the light colours.
 *   - Outlook on the web and the new Outlook get their own dark colours by the attributes they put on
 *     what they recolour ([data-ogsc] / [data-ogsb], descendant form), on the inner layers.
 *   - Those Outlook colours (O) sit one step off Apple Mail's (D), so a screenshot shows which rule
 *     drew each surface. Not yet confirmed in the owner's Outlook (24 Nov).
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
const C = { ink: '#16302a', text: '#2b3c39', muted: '#5f6e69', page: '#eef2f0', sheet: '#ffffff', edge: '#dbe3df', line: '#e4eae7', brand: '#1f6b57', box: '#edf5f0', boxLabel: '#4d5d58' };
/** Dark mode, as Apple Mail draws it. */
const D = { page: '#1a1d1c', sheet: '#242a28', box: '#2d3734', line: '#343d3a', ink: '#f1f5f3', text: '#d9e1de', muted: '#a9b6b1', brand: '#7fd3b3' };
/** Dark mode for Outlook: the same colours one step off, so a screenshot tells the two rules apart. */
const O = { page: '#1a1d1b', sheet: '#242a27', box: '#2d3733', line: '#343d39' };

function darkRules(sel: (attr: 'c' | 'b', cls: string) => string, lineColour: string): string {
  const rules: string[] = [];
  const text = (cls: string, v: string) => rules.push(`${sel('c', cls)}{color:${v}!important}`);
  const line = (cls: string, v: string) => rules.push(`${sel('b', cls)}{border-color:${v}!important}`);
  text('cd-ink', D.ink); text('cd-text', D.text); text('cd-muted', D.muted); text('cd-link', D.brand);
  for (const t of Object.keys(TONES) as Tone[]) text(`cd-${t}`, TONES[t][1]);
  line('cd-line', lineColour);
  // The app's own white wordmark in place of the evergreen one.
  rules.push(`${sel('c', 'cd-logo-light')}{display:none!important}`);
  rules.push(`${sel('c', 'cd-logo-dark')}{display:block!important;max-height:none!important;overflow:visible!important}`);
  return rules.join('\n');
}
const SURFACES = ['page', 'sheet', 'box'] as const;
/**
 * Two blocks: Gmail drops a whole block it cannot read, so Outlook's rules stand apart. Surfaces in
 * the media query go by attribute selector (Apple Mail matches them; Outlook, which renames classes,
 * should not); Outlook's go by its own attributes, onto the inner layer that has no inline colour.
 */
const DARK_STYLE = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
${SURFACES.map((s) => `[class~="cd-${s}"]{background-color:${D[s]}!important}`).join('\n')}
${darkRules((_, cls) => `.${cls}`, D.line)}
}
</style>
<style>
${SURFACES.map((s) => `[data-ogsb] .cd-${s}{background-color:${O[s]}!important}`).join('\n')}
${darkRules((attr, cls) => `[data-ogs${attr}] .${cls}`, O.line)}
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr><td bgcolor="${C.brand}" style="border-radius:10px;background-color:${C.brand}"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;border-radius:10px;${type(14, 600, 20, '#ffffff', 'text-decoration:none')}">${escapeHtml(label)}</a></td></tr></table>`;
}

function itemHtml(i: EmailItem, appUrl: string, timezone: string) {
  const k = kindOf(i.kind);
  return `
    <tr><td class="cd-line" style="border-top:1px solid ${C.line};padding:24px 32px 28px 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td class="cd-${k.tone}" style="${type(13, 600, 18, TONES[k.tone][0])}">${escapeHtml(k.label)}</td>
        <td align="right" class="cd-muted" style="${type(12, 400, 18, C.muted)}">${escapeHtml(when(i.at, timezone))}</td>
      </tr></table>
      <div class="cd-ink" style="margin-top:8px;${type(17, 600, 24, C.ink)}">${escapeHtml(i.name)}${i.company ? `<span class="cd-muted" style="${type(17, 400, 24, C.muted)}"> · ${escapeHtml(i.company)}</span>` : ''}</div>
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
  // The waiting lines are links in plain ink (owner, 24 Nov: not green, no arrows).
  const linkStyle = type(17, 600, 25, C.ink, 'text-decoration:none');
  const waiting: string[] = [];
  if (extras.approvalsWaiting) waiting.push(`<a href="${escapeHtml(abs(appUrl, '/meetings/approval'))}" class="cd-ink" style="${linkStyle}">${extras.approvalsWaiting} meeting${extras.approvalsWaiting === 1 ? '' : 's'} waiting for your approval</a>`);
  if (extras.crmReplies) waiting.push(`<a href="${escapeHtml(abs(appUrl, '/home'))}" class="cd-ink" style="${linkStyle}">${extras.crmReplies} repl${extras.crmReplies === 1 ? 'y' : 'ies'} from your CRM contacts</a>`);
  const inline = opts.images === 'inline';
  const src = (w: Wordmark) => (inline ? `data:image/png;base64,${w.png}` : `cid:${w.id}`);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(subject)}</title>
${DARK_STYLE}
</head>
<body class="cd-page" style="margin:0;padding:0;background-color:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;color:${C.page}">${escapeHtml(n ? items.map((i) => i.title).join(' · ').slice(0, 140) : intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.page}" class="cd-page" style="background-color:${C.page}"><tr><td class="cd-page" align="center" style="padding:28px 16px 36px 16px;color:${C.ink}">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="${C.sheet}" class="cd-sheet cd-line" style="width:100%;max-width:600px;background-color:${C.sheet};border:1px solid ${C.edge};border-radius:16px;border-collapse:separate"><tr><td class="cd-sheet" style="border-radius:15px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:30px 32px 30px 32px">
      ${wordmarkHtml(src)}
      <div class="cd-ink" style="margin-top:26px;${type(22, 600, 30, C.ink)}">Hi ${escapeHtml(opts.firstName)},</div>
      <div class="cd-muted" style="margin-top:6px;${type(15, 400, 23, C.muted)}">${escapeHtml(intro)}</div>
      ${waiting.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.box}" class="cd-box" style="margin-top:22px;background-color:${C.box};border-radius:12px;border-collapse:separate"><tr><td class="cd-box" style="border-radius:12px;padding:14px 18px 16px 18px">
        <div class="cd-text" style="${type(12, 600, 18, C.boxLabel)}">Waiting for you</div>
        ${waiting.map((w) => `<div style="margin-top:2px">${w}</div>`).join('')}
      </td></tr></table>` : ''}
    </td></tr>
    ${items.map((i) => itemHtml(i, appUrl, timezone)).join('')}
    </table>
  </td></tr></table>
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px"><tr><td align="left" class="cd-muted" style="padding:18px 6px 0 6px;${type(12, 400, 19, C.muted)}">You get these because they are in your bell in Cadence. Only what you may see is sent. <a href="${escapeHtml(abs(appUrl, '/email-preferences'))}" class="cd-link" style="color:${C.brand}">Choose how Cadence emails you</a>.</td></tr></table>
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
