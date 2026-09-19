import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string, password = 'password123') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}
const admin = (page: Page) => login(page, 'admin@cadence.local', 'admin12345');
async function logout(page: Page) {
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);
}

test('the directories fit their width and collapse repeated tags to one', async ({ page }) => {
  await admin(page);
  for (const path of ['/accounts?pod=&fo=', '/people?pod=&fo=']) {
    await page.goto(path);
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    const overflow = await page.locator('table').evaluate((table) => {
      const scroller = table.parentElement as HTMLElement;
      return scroller.scrollWidth - scroller.clientWidth;
    });
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
  }

  // Every row of the FOs column reads on one line: the first name, then how many more.
  await page.goto('/accounts?pod=&fo=');
  const headers = await page.locator('table thead th').allTextContents();
  const fos = headers.findIndex((text) => text.trim() === 'FOs');
  expect(fos).toBeGreaterThan(-1);
  const badgesPerRow = await page.locator('tbody tr').evaluateAll((rows, index) => rows.map((row) => row.children[index].querySelectorAll('.badge').length), fos);
  for (const count of badgesPerRow) expect(count).toBeLessThanOrEqual(1);
  const more = page.locator('tbody tr').nth(0).locator(`td:nth-child(${fos + 1})`).getByRole('button', { name: /^Show \d+ more FOs$/ });
  if (await more.count()) {
    await more.first().click();
    await expect(page.getByRole('button', { name: 'Show fewer FOs' }).first()).toBeVisible();
  }
});

test('the accounts search names what it searches and the columns sort themselves', async ({ page }) => {
  await admin(page);
  await page.goto('/accounts?pod=&fo=');
  await expect(page.getByLabel('Search accounts')).toHaveAttribute('placeholder', 'Search name or domain');
  for (const gone of ['industry', 'city']) {
    await expect(page.getByLabel('Search accounts')).not.toHaveAttribute('placeholder', new RegExp(gone, 'i'));
  }
  // Accounts open on most people first, so the first click on that column reverses it.
  const header = page.getByRole('columnheader', { name: /People at account/ }).getByRole('button');
  await header.click();
  await expect(page).toHaveURL(/dir=asc/);
  const ascending = await page.locator('tbody tr').evaluateAll(rows => rows.map(row => Number(row.children[4].textContent?.replace(/,/g, ''))));
  expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
  await header.click();
  await expect(page).toHaveURL(/dir=desc/);
  const descending = await page.locator('tbody tr').evaluateAll(rows => rows.map(row => Number(row.children[4].textContent?.replace(/,/g, ''))));
  expect(descending).toEqual([...descending].sort((a, b) => b - a));
});

test('people keeps one row of filters and no list-category dropdown', async ({ page }) => {
  await admin(page);
  await page.goto('/people?pod=&fo=');
  await expect(page.getByLabel('Filter by list category')).toHaveCount(0);
  const tier = page.getByLabel('Filter by tier', { exact: true });
  await expect(tier).toBeHidden();
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(tier).toBeVisible();
  await expect(page.getByLabel('Filter by campaign state')).toBeVisible();
});

test('an admin blocks an account out of the platform and puts it back', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await admin(page);
  await page.goto('/accounts?pod=&fo=');
  await page.getByRole('link', { name: 'Dummy Company B' }).click();
  await expect(page.getByRole('heading', { name: 'Dummy Company B' })).toBeVisible();
  await page.getByRole('button', { name: 'Block account' }).click();
  await expect(page.getByText('Blocked account', { exact: true })).toBeVisible();

  try {
    await page.goto('/accounts?pod=&fo=');
    await expect(page.getByRole('link', { name: 'Dummy Company B' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Dummy Company A' })).toBeVisible();

    // Its people go with it: Dummy Four works there.
    await page.goto('/people?pod=&fo=&q=Dummy%20Four');
    await expect(page.getByRole('link', { name: 'Dummy Four', exact: true })).toHaveCount(0);

    await page.goto('/settings?tab=blocked');
    await expect(page.locator('tbody tr', { hasText: 'Dummy Company B' })).toHaveCount(1);
  } finally {
    // Whatever happened above, the workspace goes back as it was for the cases that follow.
    await page.goto('/settings?tab=blocked');
    const row = page.locator('tbody tr', { hasText: 'Dummy Company B' });
    if (await row.count()) await row.getByRole('button', { name: 'Unblock' }).click();
    await expect(page.locator('tbody tr', { hasText: 'Dummy Company B' })).toHaveCount(0);
  }

  await page.goto('/accounts?pod=&fo=');
  await expect(page.getByRole('link', { name: 'Dummy Company B' })).toBeVisible();
  await page.goto('/people?pod=&fo=&q=Dummy%20Four');
  await expect(page.getByRole('link', { name: 'Dummy Four', exact: true })).toBeVisible();
  await logout(page);
});

test('only an admin can block an account', async ({ page }) => {
  await login(page, 'alisa@cadence.local');
  await page.goto('/accounts?pod=&fo=');
  await page.getByRole('link', { name: 'Dummy Company B' }).click();
  await expect(page.getByRole('button', { name: 'Block account' })).toHaveCount(0);
  await page.goto('/settings?tab=blocked');
  await expect(page).not.toHaveURL(/settings/);
  await logout(page);
});
