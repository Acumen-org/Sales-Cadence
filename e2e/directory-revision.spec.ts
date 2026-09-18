import { expect, test, type Page } from '@playwright/test';
async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ria@cadence.local');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}
/** The direction is the arrow beside the sort menu now, not a dropdown of its own. */
async function setDirection(page: Page, direction: 'asc' | 'desc') {
  const toggle = page.getByRole('button', { name: /^Sort direction/ });
  const wanted = direction === 'asc' ? 'ascending' : 'descending';
  if (!((await toggle.getAttribute('aria-label')) ?? '').includes(wanted)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', new RegExp(wanted));
}
test('account associations, explicit whole-account count and both sort directions', async ({ page }) => {
  await login(page);
  await page.goto('/accounts?pod=&fo=');
  await expect(page.getByText('People with an account', { exact: true })).toBeVisible();
  for (const column of ['PODs', 'FOs', 'Product']) await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
  for (const column of ['Industry', 'City', 'Owner']) await expect(page.getByRole('columnheader', { name: column, exact: true })).toHaveCount(0);
  for (const direction of ['asc', 'desc'] as const) {
    await setDirection(page, direction);
    await expect(page).toHaveURL(new RegExp(`dir=${direction}`));
    const counts = await page.locator('tbody tr').evaluateAll(rows => rows.map(row => Number(row.children[4].textContent?.replace(/,/g, ''))));
    expect(counts).toEqual([...counts].sort((a, b) => direction === 'asc' ? a - b : b - a));
  }
});
test('Twenty tags apply filters, survive reload and can be cleared', async ({ page }) => {
  await login(page);
  await page.goto('/people?pod=&fo=');
  await expect(page.getByRole('columnheader', { name: 'Tags in Twenty', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Recent activity', exact: true })).toHaveCount(0);
  const tag = page.locator('tbody').getByRole('button', { name: /^Filter by / }).first();
  await expect(tag).toBeVisible();
  await tag.click();
  await expect(page).toHaveURL(/(?:tier|type|product|tag|listCategory)=/);
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await page.getByTitle('Remove this filter', { exact: true }).first().click();
  await expect(page).not.toHaveURL(/(?:tier|type|product|tag|listCategory)=/);
  for (const direction of ['desc', 'asc'] as const) {
    await setDirection(page, direction);
    await expect(page).toHaveURL(new RegExp(`dir=${direction}`));
    await expect(page.getByLabel('Filter by FO', { exact: true })).toHaveValue('');
  }
});
test('enrichment export preserves direction', async ({ page }) => {
  await login(page);
  await page.goto('/enrichment');
  await setDirection(page, 'desc');
  await expect(page).toHaveURL(/dir=desc/);
  await expect(page.locator('a[href*="/enrichment/export"]')).toHaveAttribute('href', /dir=desc/);
});

test('name order matches displayed first names and survives a pending search', async ({ page }) => {
  await login(page);
  await page.goto('/people?pod=&fo=');
  for (const direction of ['asc', 'desc'] as const) {
    await setDirection(page, direction);
    const names = await page.locator('tbody a[href^="/people/"]').allTextContents();
    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort((a, b) => (direction === 'asc' ? 1 : -1) * a.trim().toLowerCase().localeCompare(b.trim().toLowerCase())));
  }
  await page.getByPlaceholder(/Search/).fill('Nina');
  await page.getByRole('button', { name: /^Sort direction/ }).click();
  await expect(page).toHaveURL(/q=Nina/);
  await expect(page).toHaveURL(/dir=asc/);
  await expect(page.getByPlaceholder(/Search/)).toHaveValue('Nina');
  await page.reload();
  await expect(page.getByPlaceholder(/Search/)).toHaveValue('Nina');
  await expect(page.getByLabel('Filter by FO', { exact: true })).toHaveValue('');
});
