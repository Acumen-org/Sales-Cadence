import { expect, test, type Page } from '@playwright/test';

/**
 * Owner, 21 Nov 2026: Meetings, gamified (your month, the pod race, recent wins with a 👏, a
 * celebration after saving), and the bell by email (each person picks how it emails them).
 */
const PASSWORD = 'password123';

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}
async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${page.url()} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
}

test('a booked meeting is celebrated, scores on the board, and a colleague cheers it', async ({ page }) => {
  const title = `E2E scoreboard ${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);
  await signIn(page, 'karson@cadence.local');
  await page.goto('/meetings/new');
  await page.getByLabel('Recording link').fill(`https://acme.zoom.us/rec/share/${Date.now()}`);
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Date', { exact: true }).fill(today);
  await page.getByRole('combobox', { name: 'Find a prospect in the CRM' }).fill('Dummy Eight');
  await page.getByRole('listbox', { name: 'Find a prospect in the CRM results' }).getByRole('option', { name: /^Dummy Eight / }).click({ timeout: 20_000 });
  await page.getByRole('group', { name: 'Products' }).getByText('Acubooth', { exact: true }).click();
  await page.getByRole('button', { name: 'Add meeting', exact: true }).click();
  // The celebration, once: the address loses ?celebrate=1.
  await expect(page.getByRole('status').filter({ hasText: /meeting(s)? this month/ })).toBeVisible();
  await expect(page).not.toHaveURL(/celebrate=1/);

  await page.getByRole('link', { name: 'See the scoreboard' }).click();
  const month = page.getByRole('region', { name: 'Your month' });
  await expect(month).toContainText(/\/ \d+\s*booked/);
  await expect(month).toContainText(/Target: \d+ a month/);
  await expect(month.getByRole('img', { name: /(On pace|Behind pace|Target reached)/ })).toBeVisible();
  await expect(month.getByRole('list', { name: 'Badges this month' })).toContainText('On the board');
  await expect(page.getByRole('region', { name: 'Pod race' })).toContainText('Your pod');
  await expect(page.getByRole('region', { name: 'Recent wins' })).toContainText('You booked');
  await noSideScroll(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTitle('Sign out').click();

  // A Sales Leader sees their pods' month, and cheers Karson's meeting from Recent wins.
  await signIn(page, 'leigh@cadence.local');
  await page.goto('/meetings');
  await expect(page.getByRole('region', { name: /Your pods? this month/ })).toContainText(/Target: \d+ per FO × \d+ FOs?/);
  // A top booker's name opens the meetings behind their number: as many rows as the number says.
  const top = page.getByRole('region', { name: 'Pod race' }).getByRole('link', { name: /booked this month\. Open their meetings/ }).first();
  const booked = Number((await top.getAttribute('aria-label'))!.match(/, (\d+) booked this month/)![1]);
  await top.click();
  await expect(page).toHaveURL(/booked=.*&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}&counted=1/);
  await expect(page.getByText(/Showing the meetings that count on the scoreboard for /)).toBeVisible();
  await expect(page.locator('table.table-meetings tbody tr')).toHaveCount(booked);
  await page.goto('/meetings');
  const cheer = page.getByRole('region', { name: 'Recent wins' }).getByRole('button', { name: /Cheer Karson/ }).first();
  await cheer.click();
  await expect(page.getByRole('region', { name: 'Recent wins' }).getByRole('button', { name: /Take back your cheer for Karson/ }).first()).toHaveAttribute('aria-pressed', 'true');
});

test('each person chooses how Cadence emails them', async ({ page }) => {
  await signIn(page, 'alisa@cadence.local');
  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByRole('link', { name: 'Email me' }).click();
  await expect(page).toHaveURL(/\/email-preferences$/);
  await page.getByRole('radio', { name: /Morning summary only/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved. You get one morning summary on weekdays.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: /Morning summary only/ })).toBeChecked();
  await page.getByRole('radio', { name: /What needs me/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved\. What needs you/)).toBeVisible();
});
