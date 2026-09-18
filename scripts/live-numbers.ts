import { chromium } from '@playwright/test';

/**
 * `pnpm exec tsx scripts/live-numbers.ts`: the figures an FO compares between pages, read from a
 * running Cadence as that FO, so a disagreement is caught where the reader sees it.
 *
 *   LIVE_URL=... LIVE_EMAIL=... LIVE_PASSWORD=... pnpm exec tsx scripts/live-numbers.ts
 *
 * Read-only. Prints the Home tiles, the People list count behind "My people", the Accounts tiles
 * and the full People count.
 */
const url = (process.env.LIVE_URL ?? '').replace(/\/+$/, '');
const email = process.env.LIVE_EMAIL ?? '';
const password = process.env.LIVE_PASSWORD ?? '';
if (!url || !email || !password) { console.error('Set LIVE_URL, LIVE_EMAIL and LIVE_PASSWORD.'); process.exit(2); }

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());
  await page.goto(`${url}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

  const tiles = async () => {
    const out: Record<string, string> = {};
    for (const tile of await page.locator('main a, main div').filter({ has: page.locator('.text-\\[11px\\]') }).all()) {
      const text = (await tile.innerText().catch(() => '')).split('\n').map((t) => t.trim()).filter(Boolean);
      if (text.length >= 2 && /^\d[\d,]*$/.test(text[1]) && text[0].length < 40 && !out[text[0]]) out[text[0]] = text[1];
    }
    return out;
  };

  await page.goto(`${url}/home`, { waitUntil: 'networkidle' });
  const home = await tiles();
  console.log('Home tiles:', JSON.stringify(home));
  const myPeople = page.getByRole('link', { name: /My people/ }).first();
  const href = await myPeople.getAttribute('href').catch(() => null);
  console.log('My people link:', href);
  if (href) {
    await page.goto(`${url}${href}`, { waitUntil: 'networkidle' });
    const header = await page.locator('main').innerText();
    const m = header.match(/(\d[\d,]*)\s+results?/);
    console.log('People list behind "My people":', m ? m[1] : '(no count found)', '| FO filter:', await page.getByLabel('Filter by FO').locator('option:checked').innerText().catch(() => '?'), '| pod filter:', await page.getByLabel('Filter by pod').locator('option:checked').innerText().catch(() => '?'));
  }
  await page.goto(`${url}/people?pod=&fo=`, { waitUntil: 'networkidle' });
  const all = (await page.locator('main').innerText()).match(/(\d[\d,]*)\s+results?/);
  console.log('People, everyone:', all ? all[1] : '(no count found)');
  await page.goto(`${url}/accounts?pod=&fo=`, { waitUntil: 'networkidle' });
  console.log('Accounts tiles:', JSON.stringify(await tiles()));
  await page.goto(`${url}/people?pod=&fo=&account=none`, { waitUntil: 'networkidle' });
  const none = (await page.locator('main').innerText()).match(/(\d[\d,]*)\s+results?/);
  console.log('People without an account:', none ? none[1] : '(no count found)');
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(2); });
