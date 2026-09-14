import { expect, test, type Page } from '@playwright/test';
async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ria@cadence.local');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}
test('account associations, explicit whole-account count and both sort directions', async ({ page }) => {
  await login(page);
  await page.goto('/accounts?pod=&fo=');
  await expect(page.getByText('People at matching accounts', { exact: true })).toBeVisible();
  for (const column of ['PODs', 'FOs', 'Product']) await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
  for (const column of ['Industry', 'City', 'Owner']) await expect(page.getByRole('columnheader', { name: column, exact: true })).toHaveCount(0);
  for (const direction of ['asc', 'desc']) {
    await page.getByLabel('Sort direction').selectOption(direction);
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
  for (const direction of ['desc', 'asc']) {
    await page.getByLabel('Sort direction').selectOption(direction);
    await expect(page).toHaveURL(new RegExp(`dir=${direction}`));
    await expect(page.getByLabel('Filter by FO', { exact: true })).toHaveValue('');
  }
});
test('enrichment export preserves direction', async ({ page }) => {
  await login(page);
  await page.goto('/enrichment');
  await page.getByLabel('Sort direction').selectOption('desc');
  await expect(page).toHaveURL(/dir=desc/);
  await expect(page.locator('a[href*="/enrichment/export"]')).toHaveAttribute('href', /dir=desc/);
});
