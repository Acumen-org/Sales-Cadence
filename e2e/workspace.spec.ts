import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /^Alisa/ }).click();
  await expect(page).toHaveURL(/\/home/);
});

test('search contains focus, opens a result, and restores focus on dismissal', async ({ page }) => {
  await page.goto('/accounts');
  const trigger = page.getByRole('button', { name: 'Search', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Search workspace' });
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('Dummy');
  await expect(dialog.getByRole('option').first()).toBeVisible();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Dummy');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/people\//);
});

test('task shortcuts stay inactive while help is open', async ({ page }) => {
  await page.goto('/tasks?tab=upcoming');
  await page.getByLabel('Help', { exact: true }).click();
  const url = page.url();
  await page.keyboard.press('d');
  await page.keyboard.press('n');
  await page.keyboard.press('s');
  await expect(page.getByRole('dialog', { name: 'Shortcuts and help' })).toBeVisible();
  expect(page.url()).toBe(url);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Skip this one step')).toHaveCount(0);
});

test('an account reads from Twenty on open, with no sync button to press', async ({ page }) => {
  await page.goto('/accounts');
  await page.getByRole('link', { name: 'Dummy Company A', exact: true }).click();
  await page.waitForURL(/\/accounts\/[a-z0-9-]+/);
  // Syncing is continuous: nothing asks the user to fetch their own data.
  await expect(page.getByRole('button', { name: /Sync/i })).toHaveCount(0);
  // And the record is there, freshly read.
  await expect(page.getByRole('heading', { name: 'Dummy Company A' })).toBeVisible();
  await expect(page.locator('main')).toContainText('Asset management');
});

test('sequence library supports search and empty-state recovery', async ({ page }) => {
  await page.goto('/sequences');
  await page.getByLabel('Search sequences').fill('no-such-sequence');
  await page.getByLabel('Search sequences').press('Enter');
  await expect(page.getByText('No matching sequences')).toBeVisible();
  await page.getByRole('link', { name: 'Clear filters' }).click();
  await expect(page.getByRole('link', { name: /Default outbound/ })).toBeVisible();
});

test('mobile navigation and all main sections fit a phone', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['home', 'tasks', 'accounts', 'people', 'meetings', 'sequences', 'campaigns', 'activity', 'reports']) {
    await page.goto(`/${route}`);
    await expect(page.getByLabel('Open navigation')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), route).toBe(true);
    // Named per route, because "something threw" is not a bug report.
    expect(errors, route).toEqual([]);
  }
  await page.getByLabel('Open navigation').click();
  const menu = page.getByRole('dialog', { name: 'Navigation' });
  await expect(menu).toBeVisible();
  await menu.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page).toHaveURL(/\/people/);
  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
});
