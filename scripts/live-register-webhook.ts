import { chromium } from '@playwright/test';

/**
 * `pnpm exec tsx scripts/live-register-webhook.ts`: press "Register webhook in Twenty" on a running
 * Cadence as an admin and print what it answered, then the Twenty status card. One write, in
 * Twenty, that the button exists to make.
 *
 *   LIVE_URL=... LIVE_EMAIL=... LIVE_PASSWORD=... pnpm exec tsx scripts/live-register-webhook.ts
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
  await page.goto(`${url}/settings?tab=twenty`, { waitUntil: 'networkidle' });
  if (!page.url().includes('/settings')) { console.error('Not an admin: settings redirected.'); await browser.close(); process.exit(2); }
  const button = page.getByRole('button', { name: 'Register webhook in Twenty' });
  if (!(await button.count())) { console.error('The button is not on this build yet.'); await browser.close(); process.exit(2); }
  await button.click();
  const status = page.locator('[role=status], [role=alert]').filter({ hasText: /./ }).first();
  await status.waitFor({ timeout: 30_000 }).catch(() => {});
  console.log('Answer:', ((await status.innerText().catch(() => '')) || '(no message shown)').replace(/\s+/g, ' ').trim());
  await page.reload({ waitUntil: 'networkidle' });
  console.log('Status card:', (await page.locator('main dl').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400));
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(2); });
