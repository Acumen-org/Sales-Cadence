import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

/**
 * `pnpm exec tsx scripts/live-speed.ts`: how long a click takes to answer on a running Cadence,
 * measured the way a reader feels it - from the click to the new content being on screen - for the
 * tabs of a person page and an account page and for the sidebar sections. Also the document time
 * of each of those URLs, to tell server time from client time. Screenshots of the record pages
 * land in .live/speed/. Read-only.
 *
 *   LIVE_URL=... LIVE_EMAIL=... LIVE_PASSWORD=... pnpm exec tsx scripts/live-speed.ts
 */
const url = (process.env.LIVE_URL ?? '').replace(/\/+$/, '');
const email = process.env.LIVE_EMAIL ?? '';
const password = process.env.LIVE_PASSWORD ?? '';
if (!url || !email || !password) { console.error('Set LIVE_URL, LIVE_EMAIL and LIVE_PASSWORD.'); process.exit(2); }
const outDir = path.resolve('.live/speed');
fs.mkdirSync(outDir, { recursive: true });

async function clickAndWait(page: Page, name: string, click: () => Promise<void>, settled: () => Promise<unknown>) {
  const t = Date.now();
  await click();
  await settled();
  const shown = Date.now() - t;
  await page.waitForLoadState('networkidle').catch(() => {});
  return `${name}: content ${shown} ms, idle ${Date.now() - t} ms`;
}

async function documentTime(page: Page, href: string) {
  const t = Date.now();
  const res = await page.goto(`${url}${href}`, { waitUntil: 'commit' });
  const ttfb = Date.now() - t;
  await page.waitForLoadState('load').catch(() => {});
  return `${href}  ${res?.status()}  document ${ttfb} ms, load ${Date.now() - t} ms`;
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
  const personHref = await page.locator('main tbody a[href^="/people/"]').first().getAttribute('href');
  await page.goto(`${url}/accounts?pod=&fo=`, { waitUntil: 'networkidle' });
  const accountHref = await page.locator('main tbody a[href^="/accounts/"]').first().getAttribute('href');

  console.log('-- Document time (server) per record tab');
  for (const href of [personHref!, `${personHref}?tab=sequences`, `${personHref}?tab=tasks`, `${personHref}?tab=activity`, `${personHref}?tab=emails`, `${personHref}?tab=notes`, accountHref!, `${accountHref}?tab=people`, `${accountHref}?tab=timeline`, `${accountHref}?tab=work`, `${accountHref}?tab=meetings`, `${accountHref}?tab=tasks`]) console.log('   ' + await documentTime(page, href));

  console.log('\n-- Click to content: person tabs');
  await page.goto(`${url}${personHref}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(outDir, 'person.png'), fullPage: false });
  for (const tab of ['Campaigns', 'Tasks', 'Activity', 'Emails', 'Notes', 'Overview']) {
    const link = page.locator('main a').filter({ hasText: new RegExp(`^${tab}`) }).first();
    console.log('   ' + await clickAndWait(page, tab, () => link.click(), () => page.waitForFunction((t) => document.querySelector('main a[aria-current="page"]')?.textContent?.startsWith(t), tab, { timeout: 20_000 })));
  }
  console.log('\n-- Click to content: account tabs');
  await page.goto(`${url}${accountHref}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(outDir, 'account.png'), fullPage: false });
  for (const tab of ['People', 'Timeline', 'Campaigns', 'Meetings', 'Tasks', 'Overview']) {
    const link = page.locator('main a').filter({ hasText: new RegExp(`^${tab}$`) }).first();
    if (!(await link.count())) { console.log(`   ${tab}: no tab`); continue; }
    console.log('   ' + await clickAndWait(page, tab, () => link.click(), () => page.waitForFunction((t) => document.querySelector('main a[aria-current="page"]')?.textContent?.startsWith(t), tab, { timeout: 20_000 })));
  }
  console.log('\n-- Click to content: sidebar sections');
  for (const section of ['Tasks', 'Accounts', 'People', 'Enrichment', 'Meetings', 'Sequences', 'Campaigns', 'Activity', 'Reports', 'Home']) {
    const link = page.locator('aside a').filter({ hasText: new RegExp(`^${section}$`) }).first();
    if (!(await link.count())) { console.log(`   ${section}: not in the sidebar`); continue; }
    console.log('   ' + await clickAndWait(page, section, () => link.click(), () => page.waitForFunction((s) => document.querySelector('main h1')?.textContent?.includes(s === 'Home' ? 'Good' : s), section, { timeout: 20_000 })));
  }
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(2); });
