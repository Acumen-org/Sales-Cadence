import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email = 'admin@cadence.local', password = 'admin12345') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

/**
 * Enrichment as work: the queue folds under the account, scores by field, filters on facts about
 * the record in one row, and a selection can be exported, handed to somebody or marked not found -
 * which hides the gap until it is reopened.
 */
test('enrichment folds by account, scores by field and carries the record filters in one row', async ({ page }) => {
  await login(page);
  await page.goto('/enrichment?tab=byaccount');
  await expect(page.getByRole('columnheader', { name: 'Account needs' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Most missing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true }).first()).toBeVisible();

  await page.goto('/enrichment?tab=scorecard');
  await expect(page.getByText('Everyone', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Email' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'AUM' })).toBeVisible();

  await page.goto('/enrichment?tab=contacts');
  // One row: search, pod, FO, what is missing, sort; the rest behind Filters.
  for (const label of ['Search records to enrich', 'Filter by pod', 'Filter by FO', 'Missing information', 'Sort']) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Filter by tier', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Filters/ }).click();
  for (const label of ['Filter by account', 'Filter by tier', 'Filter by contact type', 'Filter by product', 'Filter by campaign', 'Filter by Twenty tag', 'Filter by priority', 'Show open or not-found gaps']) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await page.getByLabel('Filter by priority', { exact: true }).selectOption('critical');
  await expect(page).toHaveURL(/priority=critical/);
  await expect(page.locator('tbody td:nth-child(4)').filter({ hasText: 'Useful' })).toHaveCount(0);
  const href = await page.getByRole('link', { name: 'Export to enrich' }).getAttribute('href');
  expect(href).toContain('priority=critical');
  expect(href).toContain('entity=person');
  await page.goto('/enrichment?tab=accounts');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByLabel('Filter by tier', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Filter by priority', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Filter by pod', { exact: true })).toBeVisible();
});

test('a selection is exported, assigned for research, marked not found and reopened', async ({ page }) => {
  await login(page);
  await page.goto('/enrichment?tab=contacts');
  const firstRow = page.locator('tbody tr').first();
  const name = (await firstRow.locator('a[href^="/people/"]').first().innerText()).trim();
  await page.getByLabel(`Select ${name}`).check();
  await expect(page.getByRole('button', { name: 'Export 1', exact: true })).toBeVisible();

  // Hand the gaps to somebody: the badge names them.
  const assignee = page.getByLabel('Assign research to');
  await assignee.selectOption({ index: 1 });
  const who = await assignee.locator('option:checked').innerText();
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) }).first()).toContainText(`· ${who}`);
  await expect(page.getByText('Being researched', { exact: true }).locator('..')).not.toContainText(/\b0\b/);

  // Nothing found: the record leaves the queue and waits under "Marked not found".
  await page.getByLabel(`Select ${name}`).check();
  await page.getByRole('button', { name: 'Not found', exact: true }).click();
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByLabel('Show open or not-found gaps', { exact: true }).selectOption('notfound');
  await expect(page).toHaveURL(/marks=notfound/);
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Marked not found' })).toBeVisible();

  // Reopened by hand, it is back in the queue.
  await page.getByLabel(`Select ${name}`).check();
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  await page.goto('/enrichment?tab=contacts');
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
});

test('the exported selection carries exactly the chosen rows', async ({ page }) => {
  await login(page);
  await page.goto('/enrichment?tab=contacts');
  const rows = page.locator('tbody tr');
  const first = (await rows.nth(0).locator('a[href^="/people/"]').first().innerText()).trim();
  const second = (await rows.nth(1).locator('a[href^="/people/"]').first().innerText()).trim();
  const firstId = (await rows.nth(0).locator('a[href^="/people/"]').first().getAttribute('href'))!.split('/').pop()!;
  const csv = await (await page.request.post('/enrichment/export', { form: { entity: 'person', ids: firstId, fields: '' } })).text();
  expect(csv).toContain('recordId');
  expect(csv).toContain(first);
  if (second !== first) expect(csv).not.toContain(second);
});
