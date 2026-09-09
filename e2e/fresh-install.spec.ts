import { expect, test, type Page } from '@playwright/test';

/**
 * The state a real deployment starts in: one admin account, the default sequence, and nothing
 * that Cadence itself created - no pods, no campaigns, no enrollments, no tasks, no meetings.
 *
 * Contacts are the exception, and deliberately so: they belong to Twenty, and a connected
 * workspace starts syncing them immediately. That is what this suite runs against - a `core`
 * seed pointed at a CRM - so it sees the app the way the team plugging it in will, on the first
 * morning, with people arriving and nobody having worked any of them yet.
 */
test.describe.configure({ mode: 'serial' });

const ADMIN = { email: 'admin@cadence.local', password: 'admin12345' };

async function sound(page: Page, path: string) {
  await page.goto(path);
  const body = await page.locator('body').innerText();
  expect(body, path).not.toContain('Application error');
  expect(body, path).not.toContain('server-side exception');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
}

test('a fresh install signs in with email and password and has no sample data', async ({ page }) => {
  await page.goto('/login');
  // No one-click sign-in, on any deployment.
  await expect(page.getByRole('button', { name: /sign in as/i })).toHaveCount(0);
  await expect(page.getByText(/Dummy|demo account/i)).toHaveCount(0);

  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);

  // Nothing was seeded but the admin: no colleagues, no pods.
  await page.goto('/settings?tab=users');
  const team = page.locator('table').first();
  await expect(team.locator('tbody tr')).toHaveCount(1);
  await expect(team).toContainText(ADMIN.email);
  await expect(page.locator('body')).not.toContainText('Dummy');
});

test('every section renders on an empty workspace', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);

  for (const path of [
    '/home',
    '/tasks?tab=today',
    '/tasks?tab=overdue',
    '/tasks?tab=upcoming',
    '/tasks?tab=done',
    '/people',
    '/accounts',
    '/enrichment',
    '/meetings',
    '/meetings/new',
    '/sequences',
    '/sequences/new',
    '/campaigns',
    '/campaigns/new',
    '/activity',
    '/reports',
    '/settings?tab=users',
    '/settings?tab=rules',
    '/settings?tab=twenty',
    '/settings?tab=ai',
    '/settings?tab=activity',
  ]) {
    await sound(page, path);
  }
});

test('the empty screens say what is missing and offer the way forward', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);

  await page.goto('/tasks?tab=today');
  await expect(page.getByText('Nothing due today')).toBeVisible();

  await page.goto('/campaigns');
  await expect(page.getByText('No campaigns yet')).toBeVisible();
  // Offered twice on purpose: in the panel header and in the empty state itself.
  await expect(page.getByRole('link', { name: /New campaign/ })).toHaveCount(2);

  // The default sequence is the one thing that ships, so a campaign can be built on day one.
  await page.goto('/sequences');
  await expect(page.getByRole('link', { name: /Default outbound/ })).toBeVisible();

  // Nothing has been worked yet, so there is no history anywhere.
  await page.goto('/meetings');
  await expect(page.getByText('No meetings')).toBeVisible();
  await page.goto('/reports');
  await expect(page.locator('main')).toContainText('0');

  // Contacts, though, are already arriving from the CRM - that is the point of the connection.
  await page.goto('/people');
  await expect(page.locator('main')).not.toContainText('Application error');
});
