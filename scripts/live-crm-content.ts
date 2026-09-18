import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

/**
 * `pnpm exec tsx scripts/live-crm-content.ts`: the owner's point 11, checked on a running Cadence.
 * For the people with the most recent CRM activity, open the Emails and Notes tabs and report what
 * a reader would notice: cards that failed to load, empty bodies, runs of blank lines, stray
 * non-breaking spaces, and whether the newest email shown is as recent as Twenty says the last
 * email was (the Overview's "Last email"). Screenshots land in .live/crm/. Read-only.
 *
 *   LIVE_URL=... LIVE_EMAIL=... LIVE_PASSWORD=... LIVE_PEOPLE=8 pnpm exec tsx scripts/live-crm-content.ts
 */
const url = (process.env.LIVE_URL ?? '').replace(/\/+$/, '');
const email = process.env.LIVE_EMAIL ?? '';
const password = process.env.LIVE_PASSWORD ?? '';
const howMany = Number(process.env.LIVE_PEOPLE ?? 8);
if (!url || !email || !password) { console.error('Set LIVE_URL, LIVE_EMAIL and LIVE_PASSWORD.'); process.exit(2); }
const outDir = path.resolve('.live/crm');
fs.mkdirSync(outDir, { recursive: true });

type CardReport = { cards: number; unavailable: boolean; emptyBodies: number; blankRuns: number; nbsp: number; noSubject: number; newest: string | null; older: boolean };

async function readTab(page: Page, href: string, kind: 'emails' | 'notes'): Promise<CardReport> {
  await page.goto(`${url}${href}?tab=${kind}`, { waitUntil: 'networkidle' });
  const main = page.locator('main');
  const text = await main.innerText();
  const cards = main.locator('details');
  const n = await cards.count();
  let emptyBodies = 0, blankRuns = 0, nbsp = 0, noSubject = 0;
  let newest: string | null = null;
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    // The body itself: the last block inside the card's content, after the From/To grid.
    const bodyEl = card.locator('details > div > div').last();
    const body = await bodyEl.innerText().catch(() => '');
    const html = await bodyEl.innerHTML().catch(() => '');
    if (!body.trim() || /No note body|Body not available/.test(body)) emptyBodies += 1;
    if (/\n[ \t]*\n[ \t]*\n[ \t]*\n/.test(body)) { blankRuns += 1; if (process.env.LIVE_EXCERPT) console.log(`       excerpt (${kind} #${i + 1}): ${JSON.stringify(body.slice(0, 240))}`); }
    if (/&nbsp;|  /.test(html)) nbsp += 1;
    if (kind === 'notes' && /^\s*\|[\s|:-]*\|?\s*$/m.test(body)) { blankRuns += 0; if (process.env.LIVE_EXCERPT) console.log(`       table pipes (note #${i + 1}): ${JSON.stringify(body.slice(0, 160))}`); }
    if (/No subject/.test(await card.locator('summary').innerText().catch(() => ''))) noSubject += 1;
    if (i === 0) newest = await card.locator('time').first().getAttribute('datetime').catch(() => null);
  }
  await page.screenshot({ path: path.join(outDir, `${href.split('/').pop()}-${kind}.png`), fullPage: true });
  return { cards: n, unavailable: /temporarily unavailable/.test(text), emptyBodies, blankRuns, nbsp, noSubject, newest, older: /Older/.test(text) };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());
  await page.goto(`${url}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

  await page.goto(`${url}/people?pod=&fo=&sort=recent&dir=desc`, { waitUntil: 'networkidle' });
  const hrefs = [...new Set((await page.locator('main tbody a[href^="/people/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''))).filter(Boolean))].slice(0, howMany);
  console.log(`Checking ${hrefs.length} people with the most recent CRM activity\n`);
  let issues = 0;
  for (const href of hrefs) {
    await page.goto(`${url}${href}`, { waitUntil: 'networkidle' });
    const name = (await page.locator('main h2').first().innerText().catch(() => href)).trim();
    const overview = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const lastEmail = overview.match(/LAST EMAIL\s+([^A-Z]{4,40}?)(?=\s[A-Z]{3,}|$)/)?.[1]?.trim() ?? null;
    const emails = await readTab(page, href, 'emails');
    const notes = await readTab(page, href, 'notes');
    const flags: string[] = [];
    if (emails.unavailable) flags.push('emails unavailable');
    if (notes.unavailable) flags.push('notes unavailable');
    if (emails.emptyBodies) flags.push(`${emails.emptyBodies} empty email bodies`);
    if (notes.emptyBodies) flags.push(`${notes.emptyBodies} empty notes`);
    if (emails.blankRuns + notes.blankRuns) flags.push(`${emails.blankRuns + notes.blankRuns} cards with runs of blank lines`);
    if (emails.nbsp + notes.nbsp) flags.push(`${emails.nbsp + notes.nbsp} cards with stray non-breaking spaces`);
    if (emails.noSubject) flags.push(`${emails.noSubject} without subject`);
    if (lastEmail && emails.cards === 0) flags.push(`Twenty says last email ${lastEmail} but no emails shown`);
    if (flags.length) issues += 1;
    console.log(`${flags.length ? 'CHECK' : 'ok   '} ${name}  ${href}\n       emails: ${emails.cards}${emails.older ? '+' : ''} (newest ${emails.newest ?? '-'}) · notes: ${notes.cards}${notes.older ? '+' : ''} (newest ${notes.newest ?? '-'}) · Twenty last email: ${lastEmail ?? '-'}${flags.length ? '\n       ' + flags.join('; ') : ''}`);
  }
  console.log(`\n${issues ? `${issues} of ${hrefs.length} people with something to look at.` : 'Nothing to look at.'} Screenshots in ${outDir}.`);
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(2); });
