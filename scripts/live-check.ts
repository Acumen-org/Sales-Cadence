import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

/**
 * `pnpm live:check`: walk a running Cadence as a signed-in user and report what it shows.
 *
 *   LIVE_URL=https://cadence.example.com LIVE_EMAIL=... LIVE_PASSWORD=... pnpm live:check
 *
 * Read-only: it signs in, opens every section, and records for each the heading, how many rows
 * or cards are on screen, every page error and console error, every response of 400 or more, and
 * a screenshot in .live/. With an admin login it also copies the Settings > Twenty status card.
 * Nothing is clicked that changes data. Exit code 1 when any route errored.
 */
const url = (process.env.LIVE_URL ?? '').replace(/\/+$/, '');
const email = process.env.LIVE_EMAIL ?? '';
const password = process.env.LIVE_PASSWORD ?? '';
if (!url || !email || !password) {
  console.error('Set LIVE_URL, LIVE_EMAIL and LIVE_PASSWORD.');
  process.exit(2);
}
const ROUTES = ['home', 'tasks', 'tasks?tab=upcoming', 'tasks?tab=done', 'accounts', 'people', 'enrichment', 'enrichment?tab=accounts', 'meetings', 'sequences', 'campaigns', 'activity', 'reports', 'settings?tab=twenty', 'settings?tab=users', 'settings?tab=activity'];
const outDir = path.resolve('.live');
fs.mkdirSync(outDir, { recursive: true });

type RouteReport = { route: string; status: number | null; heading: string | null; rows: number; text: string[]; pageErrors: string[]; consoleErrors: string[]; badResponses: string[] };

async function inspect(page: Page, route: string): Promise<RouteReport> {
  const report: RouteReport = { route, status: null, heading: null, rows: 0, text: [], pageErrors: [], consoleErrors: [], badResponses: [] };
  const onError = (e: Error) => report.pageErrors.push(e.message);
  const onConsole = (m: { type(): string; text(): string }) => { if (m.type() === 'error') report.consoleErrors.push(m.text().slice(0, 300)); };
  const onResponse = (r: { status(): number; url(): string }) => { if (r.status() >= 400) report.badResponses.push(`${r.status()} ${r.url().replace(url, '')}`); };
  page.on('pageerror', onError); page.on('console', onConsole); page.on('response', onResponse);
  try {
    const res = await page.goto(`${url}/${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
    report.status = res?.status() ?? null;
    if (page.url().includes('/login')) report.text.push('redirected to /login: this account cannot open it');
    report.heading = (await page.locator('main h1').first().textContent().catch(() => null))?.trim() ?? null;
    report.rows = await page.locator('main table tbody tr, main ol > li, main [data-row]').count();
    // The figures a reader sees: stat tiles, badges with counts, and "N events"-style meta.
    const meta = await page.locator('main .data-value, main .badge').allTextContents().catch(() => [] as string[]);
    report.text.push(...meta.map((t) => t.trim()).filter(Boolean).slice(0, 40));
    if (route.startsWith('settings?tab=twenty')) {
      const kv = await page.locator('main dl').first().allInnerTexts().catch(() => [] as string[]);
      report.text = kv.join('\n').split('\n').map((t) => t.trim()).filter(Boolean);
    }
    const empty = await page.locator('main h3').allTextContents().catch(() => [] as string[]);
    for (const t of empty) if (/^No |Nothing/.test(t)) report.text.push(`empty state: ${t}`);
    await page.screenshot({ path: path.join(outDir, `${route.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true });
  } catch (err) {
    report.pageErrors.push(err instanceof Error ? err.message : String(err));
  } finally {
    page.off('pageerror', onError); page.off('console', onConsole); page.off('response', onResponse);
  }
  return report;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());
  await page.goto(`${url}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }).catch(() => {});
  if (page.url().includes('/login')) {
    console.error(`Sign-in as ${email} did not succeed: ${(await page.locator('[role=alert]').allTextContents()).join(' ') || 'no message shown'}`);
    await browser.close();
    process.exit(2);
  }
  const who = (await page.locator('aside').first().innerText().catch(() => '')).split('\n').filter(Boolean).slice(-3).join(' / ');
  console.log(`Signed in to ${url} as ${email}${who ? ` (${who})` : ''}\n`);
  let failures = 0;
  for (const route of ROUTES) {
    const r = await inspect(page, route);
    const bad = r.pageErrors.length || r.consoleErrors.length || r.badResponses.length || (r.status !== null && r.status >= 400);
    if (bad) failures += 1;
    console.log(`${bad ? 'FAIL' : 'ok  '} /${route}  ${r.status ?? '-'}  ${r.heading ?? ''}  rows=${r.rows}`);
    for (const t of r.text) console.log(`       ${t}`);
    for (const e of r.pageErrors) console.log(`       page error: ${e}`);
    for (const e of r.consoleErrors) console.log(`       console: ${e}`);
    for (const e of r.badResponses) console.log(`       response: ${e}`);
  }
  console.log(`\nScreenshots in ${outDir}. ${failures ? `${failures} route${failures === 1 ? '' : 's'} with errors.` : 'No errors on any route.'}`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
