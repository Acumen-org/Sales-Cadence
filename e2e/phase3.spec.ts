import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email = 'admin@cadence.local', password = 'admin12345') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

/**
 * Enrichment as work: three views - People, Accounts, Scorecard - with the record filters in one
 * row behind Filters, a scorecard whose record counts open the matching queue, and a selection
 * that can be exported, handed to somebody or marked not found, which hides the gap until it is
 * reopened from the footer.
 */
test('enrichment has three views, scores by field and carries the record filters in one row', async ({ page }) => {
  await login(page);
  await page.goto('/enrichment?tab=scorecard');
  for (const gone of ['By account', 'Imports']) await expect(page.getByRole('link', { name: gone, exact: true })).toHaveCount(0);
  await expect(page.getByText('Contacts', { exact: true })).toHaveCount(0);
  await expect(page.getByText('People', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Everyone', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('By pod', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('By FO', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Email' }).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'AUM' }).first()).toBeVisible();
  // A group's record count opens that group's queue with the pod already chosen.
  const group = page.locator('a[href*="tab=contacts"][href*="pod="]').first();
  const total = Number((await group.innerText()).replace(/,/g, ''));
  await group.click();
  await expect(page).toHaveURL(/records=all/);
  await expect(page.getByText(`${total} records`, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/tab=contacts.*pod=/);
  await expect(page.getByLabel('Filter by pod', { exact: true })).not.toHaveValue('');
  // A field below 100% opens the records missing just that field.
  await page.goto('/enrichment?tab=scorecard');
  const gap = page.locator('td a[href*="field="]').first();
  const field = new URL(await gap.getAttribute('href') ?? '', 'http://x').searchParams.get('field');
  await gap.click();
  await expect(page).toHaveURL(new RegExp(`field=${field}`));
  await expect(page.locator('tbody tr').first()).toBeVisible();

  await page.goto('/enrichment?tab=contacts');
  await expect(page.getByRole('columnheader', { name: 'Person', exact: true })).toBeVisible();
  // One row: search, pod, FO, what is missing, sort; the rest behind Filters.
  for (const label of ['Search records to enrich', 'Filter by pod', 'Filter by FO', 'Missing information', 'Sort']) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Filter by tier', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Filters/ }).click();
  for (const label of ['Filter by account', 'Filter by tier', 'Filter by contact type', 'Filter by product', 'Filter by campaign', 'Filter by Twenty tag']) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  for (const label of ['Filter by priority', 'Show open or not-found gaps']) await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  const href = await page.getByRole('link', { name: 'Export to enrich' }).getAttribute('href');
  expect(href).toContain('entity=person');
  // The way back in sits beside the way out, and the upload page lists what came in before.
  await expect(page.getByRole('link', { name: 'Upload enriched file' })).toHaveAttribute('href', '/enrichment/import?entity=person');
  await page.getByRole('link', { name: 'Upload enriched file' }).click();
  await expect(page.getByRole('heading', { name: 'Upload enrichment' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Earlier uploads' })).toBeVisible();

  await page.goto('/enrichment?tab=accounts');
  await expect(page.getByRole('columnheader', { name: 'Account', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Upload enriched file' })).toHaveAttribute('href', '/enrichment/import?entity=company');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByLabel('Filter by tier', { exact: true })).toHaveCount(0);
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

  // Nothing found: the record leaves the queue and waits behind the footer's count.
  await page.getByLabel(`Select ${name}`).check();
  await page.getByRole('button', { name: 'Not found', exact: true }).click();
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: /marked not found$/ }).click();
  await expect(page).toHaveURL(/marks=notfound/);
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Marked not found' })).toBeVisible();

  // Reopened by hand, it is back in the queue.
  await page.getByLabel(`Select ${name}`).check();
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to enrichment', exact: true }).click();
  await expect(page).toHaveURL(/tab=contacts/);
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
