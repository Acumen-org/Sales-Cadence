import { BAR_DARK, BAR_HEIGHT, BAR_LIGHT, BAR_WIDTH, meetingsBarGif } from './bar';

/*
 * The bell by email (owner, 21 Nov 2026: "a nice html email that shows the contents and links it to
 * Cadence"). Tables and inline styles, so Outlook, Gmail and phones draw it the same; 600px wide.
 * Every item links to the thing in Cadence.
 *
 * The look is "Option A, a clean letter" (owner, 23 Nov 2026), on a sheet (24 Nov): the letter is a
 * filled sheet on a tinted page (white on pale green-grey; in dark mode a lifted dark sheet on a deeper
 * ground). Inside: the Cadence wordmark, the greeting in one line, then each item as its own section
 * split edge to edge, with a plain coloured label and a button. No arrows anywhere.
 * The morning summary opens with "Your day" (24 Nov): numbers, and the month's meetings as a bar.
 * Short at the top (owner, 25 Nov: "the first part is needlessly long"): numbers without boxes, the
 * meetings in two rows, the waiting lines in plain ink with no label over them.
 * The same on a phone as on a computer (25 Nov): one set of sizes, no narrow-screen rules.
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
 *     drew each surface. The owner's new Outlook drew O exactly (25 Nov screenshot).
 *   - Lines between sections are 1px filled rows, not cell borders: the new Outlook kept cell borders
 *     light in dark mode (a bright line on the dark sheet, 25 Nov) while filled surfaces took O.
 *   - The wordmark is text (owner, 25 Nov: the picture "takes a second to load"; text shows at once):
 *     the app's spacing and colours in the closest font each device has (Inter where installed, the
 *     system's own otherwise). Only the meetings bar is a picture (the owner kept it animated).
 */

export type EmailItem = { kind: string; name: string; company: string | null; title: string; detail: string | null; href: string | null; linkLabel: string; at: Date };
/**
 * "Your day" at the top of the morning summary (owner, 24 Nov 2026): numbers only, each opening its
 * page; and the month's meetings against the goal as a bar. Worked out in day.ts.
 */
export type DayTile = { label: string; value: number; href: string; warn?: boolean };
export type DayFigures = { tiles: DayTile[]; meetings: null | { label: string; count: number; goal: number; foot: string; href: string } };
export const DUE_TODAY = 'Due today';
export const OVERDUE = 'Overdue';
export type EmailExtras = { approvalsWaiting?: number; crmReplies?: number; day?: DayFigures };
/** A picture sent inside the email, shown where the html says cid:<id>. */
export type InlineImage = { id: string; contentType: 'image/png' | 'image/gif'; base64: string };
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
const C = { ink: '#16302a', text: '#2b3c39', muted: '#5f6e69', page: '#eef2f0', sheet: '#ffffff', edge: '#dbe3df', line: '#e4eae7', rule: '#e4eae7', brand: '#1f6b57', box: '#edf5f0', boxLabel: '#4d5d58', mark: '#1f6b57', dot: '#82c4ac' };
/** Dark mode, as Apple Mail draws it. */
const D = { page: '#1a1d1c', sheet: '#242a28', box: '#2d3734', line: '#343d3a', rule: '#343d3a', ink: '#f1f5f3', text: '#d9e1de', muted: '#a9b6b1', brand: '#7fd3b3', mark: '#ffffff', dot: '#d5e9ad' };
/** Dark mode for Outlook: the same colours one step off, so a screenshot tells the two rules apart. */
const O = { page: '#1a1d1b', sheet: '#242a27', box: '#2d3733', line: '#343d39', rule: '#343d39' };

function darkRules(sel: (attr: 'c' | 'b', cls: string) => string, lineColour: string): string {
  const rules: string[] = [];
  const text = (cls: string, v: string) => rules.push(`${sel('c', cls)}{color:${v}!important}`);
  const line = (cls: string, v: string) => rules.push(`${sel('b', cls)}{border-color:${v}!important}`);
  text('cd-ink', D.ink); text('cd-text', D.text); text('cd-muted', D.muted); text('cd-link', D.brand);
  // The wordmark as the app's sidebar shows it: white with the lime dot.
  text('cd-mark', D.mark); text('cd-dot', D.dot);
  for (const t of Object.keys(TONES) as Tone[]) text(`cd-${t}`, TONES[t][1]);
  line('cd-line', lineColour);
  // The dark meetings bar in place of the light one.
  rules.push(`${sel('c', 'cd-bar-light')}{display:none!important}`);
  rules.push(`${sel('c', 'cd-bar-dark')}{display:block!important;max-height:none!important;overflow:visible!important}`);
  return rules.join('\n');
}
const SURFACES = ['page', 'sheet', 'box', 'rule'] as const;
/**
 * Three blocks: Gmail drops a whole block it cannot read, so Outlook's rules, and the one animation
 * (the "Your day" block rising in), stand apart. Surfaces in
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
</style>
<style>
@keyframes cdrise{from{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){.cd-rise{animation:none!important}}
</style>
`;

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
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr><td bgcolor="${C.brand}" style="border-radius:10px;background-color:${C.brand}"><a href="${escapeHtml(href)}" style="display:inline-block;padding:9px 16px;border-radius:10px;${type(14, 600, 20, '#ffffff', 'text-decoration:none')}">${escapeHtml(label)}</a></td></tr></table>`;
}

/** A line across the sheet: a 1px filled row (two layers, like every surface), never a cell border. */
const RULE = `<tr><td bgcolor="${C.rule}" class="cd-rule" style="height:1px;font-size:1px;line-height:1px;background-color:${C.rule}"><div class="cd-rule" style="height:1px;font-size:1px;line-height:1px">&nbsp;</div></td></tr>`;
/** Inside the sheet, the same on every screen. */
const PAD = 24;

function itemHtml(i: EmailItem, appUrl: string, timezone: string) {
  const k = kindOf(i.kind);
  return `
    ${RULE}
    <tr><td class="cd-pad" style="padding:20px ${PAD}px 24px ${PAD}px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td class="cd-${k.tone}" style="${type(13, 600, 18, TONES[k.tone][0])}">${escapeHtml(k.label)}</td>
        <td align="right" class="cd-muted" style="${type(12, 400, 18, C.muted)}">${escapeHtml(when(i.at, timezone))}</td>
      </tr></table>
      <div class="cd-ink" style="margin-top:6px;${type(17, 600, 24, C.ink)}">${escapeHtml(i.name)}${i.company ? `<span class="cd-muted" style="${type(17, 400, 24, C.muted)}"> · ${escapeHtml(i.company)}</span>` : ''}</div>
      <div class="cd-text" style="margin-top:3px;${type(15, 400, 22, C.text)}">${escapeHtml(i.title)}</div>
      ${i.detail ? `<div class="cd-muted" style="margin-top:4px;${type(14, 400, 20, C.muted)}">${escapeHtml(clip(i.detail, 600))}</div>` : ''}
      ${button(abs(appUrl, i.href), i.linkLabel || 'Open in Cadence')}
    </td></tr>`;
}

/**
 * The wordmark as text, so it shows the moment the email opens (owner, 25 Nov 2026). The app's
 * semibold with its tight spacing: Inter where the device has it, else the system's own sans (San
 * Francisco on Apple devices, Segoe UI on Windows, Roboto on Android). Evergreen with the mint dot;
 * in dark mode the sidebar's white with the lime dot.
 */
const MARK_FONT = `'Inter','Inter Variable',-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI Variable Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
function wordmarkHtml() {
  return `<div class="cd-mark" style="font-family:${MARK_FONT};font-size:42px;font-weight:600;line-height:46px;letter-spacing:-0.06em;color:${C.mark}">cadence<span class="cd-dot" style="color:${C.dot}">.</span></div>`;
}

/**
 * "Your day": the numbers side by side with no boxes, then the month's meetings in two rows (what and
 * how far over its count, then the animated bar). The block rises in where the mail app plays CSS
 * animation (Apple Mail, iPhone); elsewhere it simply shows. Numbers never animate: a half-supported
 * count could show a wrong figure.
 */
function dayHtml(day: DayFigures, appUrl: string, bar: ((mode: 'light' | 'dark') => string) | null) {
  const n = day.tiles.length;
  const tile = (t: DayTile, i: number, perRow: number) => {
    const colour = t.warn && t.value > 0 ? TONES.amber[0] : C.ink;
    const cls = t.warn && t.value > 0 ? 'cd-amber' : 'cd-ink';
    // Widths in shares of the row, gaps included, so mail apps keep the gaps at every width.
    return `${i ? '<td width="3%" style="width:3%;font-size:0;line-height:0">&nbsp;</td>' : ''}<td valign="top" width="${Math.floor((100 - (perRow - 1) * 3) / perRow)}%">
          <a href="${escapeHtml(abs(appUrl, t.href))}" style="display:block;text-decoration:none">
            <div class="${cls} cd-num" style="${type(26, 700, 30, colour)}">${t.value}</div>
            <div class="cd-muted" style="margin-top:1px;${type(13, 400, 18, C.muted)}">${escapeHtml(t.label)}</div>
          </a>
        </td>`;
  };
  // At most three to a row: four go two and two, so a phone still fits the numbers.
  const rows = n === 4 ? [day.tiles.slice(0, 2), day.tiles.slice(2)] : [day.tiles];
  const tiles = rows.filter((r) => r.length).map((r, ri) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:${ri ? 12 : 0}px"><tr>${r.map((t, i) => tile(t, i, r.length)).join('')}</tr></table>`).join('');
  const m = day.meetings;
  const meetings = m ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:${n ? 18 : 0}px"><tr>
          <td valign="bottom"><a href="${escapeHtml(abs(appUrl, m.href))}" class="cd-ink" style="${type(14, 600, 20, C.ink, 'text-decoration:none')}">${escapeHtml(m.label)}</a><span class="cd-muted" style="${type(13, 400, 20, C.muted)}"> · ${escapeHtml(m.foot)}</span></td>
          <td valign="bottom" align="right" class="cd-ink" style="white-space:nowrap;padding-left:12px;${type(22, 700, 24, C.ink)}">${m.count} <span class="cd-muted" style="${type(13, 600, 24, C.muted)}">of ${m.goal}</span></td>
        </tr></table>
        ${bar ? `<div style="margin-top:8px;font-size:0;line-height:0"><div class="cd-bar-light">${barImg(bar('light'))}</div><!--[if !mso]><!--><div class="cd-bar-dark" style="display:none;max-height:0;overflow:hidden;mso-hide:all">${barImg(bar('dark'))}</div><!--<![endif]--></div>` : ''}` : '';
  return `<div class="cd-rise" style="margin-top:20px;animation:cdrise .5s ease-out .1s both">
      ${tiles}
      ${meetings}
    </div>`;
}
const barImg = (src: string) => `<img src="${src}" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" alt="" style="display:block;border:0;outline:none;width:100%;max-width:${BAR_WIDTH}px;height:auto">`;
/** The bar's share of the goal; a goal of 0 shows an empty bar. */
const barShare = (m: NonNullable<DayFigures['meetings']>) => (m.goal > 0 ? m.count / m.goal : 0);
const BAR_IDS = { light: 'cadence-bar-light', dark: 'cadence-bar-dark' } as const;
const gifBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

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
 * meetings bar in the html itself (for a preview in a page); by default it is sent alongside (cid:).
 */
export function renderBellEmail(opts: { kind: 'instant' | 'digest' | 'test'; firstName: string; items: EmailItem[]; extras?: EmailExtras; appUrl: string; timezone: string; images?: 'attached' | 'inline' }): RenderedEmail {
  const { items, appUrl, timezone } = opts;
  const extras = opts.extras ?? {};
  const n = items.length;
  const day = extras.day && (extras.day.tiles.length || extras.day.meetings) ? extras.day : null;
  const tile = (label: string) => day?.tiles.find((t) => t.label === label)?.value ?? 0;
  const dayWords = [tile(DUE_TODAY) ? `${tile(DUE_TODAY)} due today` : '', tile(OVERDUE) ? `${tile(OVERDUE)} overdue` : ''].filter(Boolean).join(', ');
  const subject = opts.kind === 'test'
    ? 'Cadence emails are working'
    : opts.kind === 'instant'
      ? n === 1 ? clip(shortSubject(items[0]), 110) : `${n} things need you in Cadence`
      : `Your Cadence summary: ${n ? `${n} update${n === 1 ? '' : 's'}` : dayWords || (day ? 'your day' : 'what is waiting')}`;
  const intro = opts.kind === 'test'
    ? 'This is a test from Settings. This is how Cadence emails look.'
    : opts.kind === 'instant'
      ? n === 1 ? 'This needs you in Cadence.' : 'These need you in Cadence.'
      : day ? (n ? 'Here is your day, and what came in since your last summary.' : 'Here is your day.') : 'Here is what came in since your last summary.';
  // The waiting lines are links in plain ink (owner, 24 Nov: not green, no arrows), no label over them (25 Nov).
  const linkStyle = type(16, 600, 24, C.ink, 'text-decoration:none');
  const waiting: string[] = [];
  if (extras.approvalsWaiting) waiting.push(`<a href="${escapeHtml(abs(appUrl, '/meetings/approval'))}" class="cd-ink" style="${linkStyle}">${extras.approvalsWaiting} meeting${extras.approvalsWaiting === 1 ? '' : 's'} waiting for your approval</a>`);
  if (extras.crmReplies) waiting.push(`<a href="${escapeHtml(abs(appUrl, '/home'))}" class="cd-ink" style="${linkStyle}">${extras.crmReplies} repl${extras.crmReplies === 1 ? 'y' : 'ies'} from your CRM contacts</a>`);
  const inline = opts.images === 'inline';
  // The meetings bar, light and dark, drawn for this person's month.
  const bars = day?.meetings ? { light: gifBase64(meetingsBarGif(barShare(day.meetings), BAR_LIGHT)), dark: gifBase64(meetingsBarGif(barShare(day.meetings), BAR_DARK)) } : null;
  const barSrc = bars ? (mode: 'light' | 'dark') => (inline ? `data:image/gif;base64,${bars[mode]}` : `cid:${BAR_IDS[mode]}`) : null;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(subject)}</title>
${DARK_STYLE}
</head>
<body class="cd-page" style="margin:0;padding:0;background-color:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;color:${C.page}">${escapeHtml(n ? items.map((i) => i.title).join(' · ').slice(0, 140) : intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.page}" class="cd-page" style="background-color:${C.page}"><tr><td class="cd-page" align="center" style="padding:20px 12px 28px 12px;color:${C.ink}">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="${C.sheet}" class="cd-sheet cd-line" style="width:100%;max-width:600px;background-color:${C.sheet};border:1px solid ${C.edge};border-radius:16px;border-collapse:separate"><tr><td class="cd-sheet" style="border-radius:15px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td class="cd-pad" style="padding:22px ${PAD}px ${PAD}px ${PAD}px">
      ${wordmarkHtml()}
      <div class="cd-muted" style="margin-top:16px;${type(16, 400, 24, C.muted)}"><span class="cd-ink" style="${type(16, 600, 24, C.ink)}">Hi ${escapeHtml(opts.firstName)},</span> ${escapeHtml(intro.charAt(0).toLowerCase() + intro.slice(1))}</div>
      ${day ? dayHtml(day, appUrl, barSrc) : ''}
      ${waiting.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.box}" class="cd-box" style="margin-top:${day ? 18 : 16}px;background-color:${C.box};border-radius:10px;border-collapse:separate"><tr><td class="cd-box" style="border-radius:10px;padding:11px 16px 12px 16px">
        ${waiting.map((w, i) => `<div${i ? ' style="margin-top:4px"' : ''}>${w}</div>`).join('')}
      </td></tr></table>` : ''}
    </td></tr>
    ${items.map((i) => itemHtml(i, appUrl, timezone)).join('')}
    </table>
  </td></tr></table>
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px"><tr><td align="left" class="cd-muted" style="padding:18px 6px 0 6px;${type(12, 400, 19, C.muted)}">You get these because they are in your bell in Cadence. Only what you may see is sent. <a href="${escapeHtml(abs(appUrl, '/email-preferences'))}" class="cd-link" style="color:${C.brand}">Choose how Cadence emails you</a>.</td></tr></table>
</td></tr></table>
</body></html>`;

  const text = [
    `Hi ${opts.firstName}, ${intro.charAt(0).toLowerCase() + intro.slice(1)}`, '',
    ...(day ? [
      `Your day: ${day.tiles.map((t) => `${t.label} ${t.value}`).join(', ')}`,
      ...(day.meetings ? [`${day.meetings.label}: ${day.meetings.count} of ${day.meetings.goal} (${day.meetings.foot})`] : []),
      '',
    ] : []),
    ...(extras.approvalsWaiting ? [`Waiting for your approval: ${extras.approvalsWaiting} meeting(s): ${abs(appUrl, '/meetings/approval')}`] : []),
    ...(extras.crmReplies ? [`Replies from your CRM contacts: ${extras.crmReplies}: ${abs(appUrl, '/home')}`] : []),
    ...items.flatMap((i) => [`- ${kindOf(i.kind).label}: ${i.name}${i.company ? ` (${i.company})` : ''}`, `  ${i.title}`, ...(i.detail ? [`  ${clip(i.detail, 300)}`] : []), `  ${abs(appUrl, i.href)}`, '']),
    `Choose how Cadence emails you: ${abs(appUrl, '/email-preferences')}`,
  ].join('\n');
  const images: InlineImage[] = inline ? [] : [
    ...(bars ? (['light', 'dark'] as const).map((mode): InlineImage => ({ id: BAR_IDS[mode], contentType: 'image/gif', base64: bars[mode] })) : []),
  ];
  return { subject, html, text, images };
}
