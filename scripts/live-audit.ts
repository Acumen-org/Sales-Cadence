import { chromium, type Page } from '@playwright/test';

/**
 * `pnpm exec tsx scripts/live-audit.ts`: the owner's own checks, run against a running Cadence as
 * a signed-in user. Read-only, except for typing into search boxes (which changes nothing).
 *
 *   LIVE_URL=... LIVE_EMAIL=... LIVE_PASSWORD=... pnpm exec tsx scripts/live-audit.ts
 *
 * Reports: server time per main route; whether a fast-typed search keeps every letter (People,
 * Accounts, Meetings, Enrichment); whether Tasks shows a campaign starting within the week; the
 * first person page opens without a CRM banner; obvious non-prospect domains are absent from
 * Accounts; the "Acubooth" meeting's talk time carries no "Unknown"; the Settings > Twenty card.
 */
const url = (process.env.LIVE_URL ?? '').replace(/\/+$/, '');
const email = process.env.LIVE_EMAIL ?? '';
const password = process.env.LIVE_PASSWORD ?? '';
if (!url || !email || !password) { console.error('Set LIVE_URL, LIVE_EMAIL and LIVE_PASSWORD.'); process.exit(2); }

const ROUTES = ['home', 'tasks', 'people', 'accounts', 'meetings', 'enrichment', 'campaigns', 'sequences', 'reports', 'activity'];

async function typedSearch(page: Page, route: string, label: string, word: string) {
  await page.goto(`${url}/${route}`, { waitUntil: 'networkidle' });
  const box = page.getByLabel(label, { exact: true }).first();
  if (!(await box.count())) return `${route}: no search box labelled "${label}"`;
  await box.click();
  await page.keyboard.type(word, { delay: 40 });
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle').catch(() => {});
  const value = await box.inputValue();
  return `${route}: typed "${word}" -> box holds "${value}" ${value === word ? 'OK' : 'LETTERS LOST'}; url has q=${new URL(page.url()).searchParams.get('q') ?? new URL(page.url()).searchParams.get('who') ?? ''}`;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());
  await page.goto(`${url}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  console.log(`Signed in as ${email}\n`);

  console.log('-- Server time per route (document response, ms)');
  for (const route of ROUTES) {
    const t = Date.now();
    const res = await page.goto(`${url}/${route}`, { waitUntil: 'commit' });
    const ttfb = Date.now() - t;
    await page.waitForLoadState('load').catch(() => {});
    console.log(`   /${route}  ${res?.status()}  ttfb=${ttfb}ms  load=${Date.now() - t}ms`);
  }

  console.log('\n-- Fast typing keeps every letter');
  for (const [route, label] of [['people', 'Search people'], ['accounts', 'Search accounts'], ['meetings', 'Search meetings'], ['enrichment', 'Search records to enrich']]) console.log('   ' + await typedSearch(page, route, label, 'Acumen strategy'));

  console.log('\n-- Tasks: campaigns starting within the week');
  await page.goto(`${url}/tasks?pod=&fo=`, { waitUntil: 'networkidle' });
  const soon = await page.locator('main').getByText(/Starting soon|starts /i).allInnerTexts().catch(() => []);
  console.log('   ' + (soon.length ? soon.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 600) : 'nothing about upcoming campaigns on Tasks'));
  await page.goto(`${url}/campaigns?tab=upcoming`, { waitUntil: 'networkidle' });
  const upcoming = await page.locator('main table tbody tr').allInnerTexts().catch(() => []);
  console.log('   Upcoming tab rows: ' + (upcoming.length ? upcoming.map((t) => t.replace(/\s+/g, ' ').trim()).join(' || ').slice(0, 800) : 'none'));

  console.log('\n-- First person page: no CRM banner');
  await page.goto(`${url}/people?pod=&fo=`, { waitUntil: 'networkidle' });
  const first = page.locator('main tbody a[href^="/people/"]').first();
  if (await first.count()) {
    await first.click();
    await page.waitForURL(/\/people\//);
    await page.waitForLoadState('networkidle').catch(() => {});
    const text = await page.locator('main').innerText();
    console.log(`   ${page.url().replace(url, '')}: ${/temporarily unavailable|Bad Gateway|Twenty unavailable/i.test(text) ? 'BANNER PRESENT' : 'no banner'}; tabs: ${(await page.locator('main a[aria-current], main nav a, main [role=tablist] a').allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean).slice(0, 8).join(', ')}`);
  }

  console.log('\n-- Obvious non-prospects absent from Accounts');
  for (const word of ['microsoft', 'google', 'anthropic', 'openai', 'gmail']) {
    await page.goto(`${url}/accounts?pod=&fo=&q=${word}`, { waitUntil: 'networkidle' });
    const rows = await page.locator('main table tbody tr').allInnerTexts().catch(() => []);
    // The whole row, so a match on the domain rather than the name is visible.
    console.log(`   "${word}": ${rows.length} account row(s)${rows.length ? ' -> ' + rows.map((r) => r.replace(/\s+/g, ' ').trim().slice(0, 90)).slice(0, 5).join(' || ') : ''}`);
    // What the match was on: the account page names the domain.
    const first = page.locator('main table tbody a[href^="/accounts/"]').first();
    if (rows.length && (await first.count())) {
      await first.click();
      await page.waitForURL(/\/accounts\//);
      await page.waitForLoadState('networkidle').catch(() => {});
      const dl = (await page.locator('main dl').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      console.log(`      ${page.url().replace(url, '')}: ${dl.match(/DOMAIN\s+(\S+)/)?.[1] ?? '(no domain shown)'}`);
    }
  }

  console.log('\n-- Meetings: talk time has no Unknown');
  await page.goto(`${url}/meetings?who=Acubooth`, { waitUntil: 'networkidle' });
  let link = page.locator('main a[href^="/meetings/"]').filter({ hasText: /Acubooth/i }).first();
  if (!(await link.count())) { await page.goto(`${url}/meetings`, { waitUntil: 'networkidle' }); link = page.locator('main a[href^="/meetings/"]').filter({ hasText: /Acubooth/i }).first(); }
  if (await link.count()) {
    await link.click();
    await page.waitForURL(/\/meetings\//);
    await page.waitForLoadState('networkidle').catch(() => {});
    const text = await page.locator('main').innerText();
    console.log(`   ${page.url().replace(url, '')}: ${/\bUnknown\b/.test(text) ? '"Unknown" PRESENT' : 'no "Unknown"'}; ${/Unattributed/.test(text) ? 'has Unattributed lines' : 'no Unattributed'}; ${/Cadence AI|Not connected/.test(text) ? 'analysis panel shown' : 'no analysis panel'}`);
  } else console.log('   no meeting named Acubooth found');

  console.log('\n-- Settings > Blocked accounts');
  await page.goto(`${url}/settings?tab=blocked`, { waitUntil: 'networkidle' });
  if (page.url().includes('/settings')) {
    const text = await page.locator('main').innerText();
    const m = text.match(/(\d[\d,]*)\s+blocked/i);
    console.log(`   ${m ? m[0] : 'no count line'}; first rows: ${(await page.locator('main table tbody tr').allInnerTexts().catch(() => [])).slice(0, 5).map((r) => r.split('\n')[0].trim()).join('; ')}`);
  }

  console.log('\n-- Settings > Twenty');
  await page.goto(`${url}/settings?tab=twenty`, { waitUntil: 'networkidle' });
  if (page.url().includes('/settings')) console.log('   ' + (await page.locator('main dl').first().innerText().catch(() => 'no status card')).replace(/\s+/g, ' ').slice(0, 700));
  else console.log('   not an admin: settings redirected');
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(2); });
