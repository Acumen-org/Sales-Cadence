import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

/**
 * "Think this is wrong?" (owner, 30 October 2026): whoever adds a meeting can say a prospect's
 * meeting number looks wrong; Biz Ops (or an admin) sees it under Meetings > Number checks, sets
 * the number on the right meeting, and closes it with what they found.
 */
test('a doubted meeting number reaches Biz Ops, who sets it and closes the check', async ({ page }) => {
  await signIn(page, 'alisa@cadence.local', 'password123');
  await page.goto('/meetings/new');
  await page.getByLabel('Title').fill('E2E number check');
  await page.getByLabel('Date', { exact: true }).fill('2026-10-02');
  await page.getByRole('combobox', { name: 'Find a prospect in Twenty' }).fill('Dummy Three');
  await page.getByRole('listbox', { name: 'Find a prospect in Twenty results' }).getByRole('option', { name: /Dummy Three/ }).click({ timeout: 20_000 });
  const prospects = page.getByRole('list', { name: 'Prospects' });
  await expect(prospects.getByText(/^\d+(st|nd|rd|th) meeting$/)).toBeVisible();

  // Two questions, either is enough; it goes to Biz Ops with the prospect, the number and the day.
  await prospects.getByRole('button', { name: 'Think the number for Dummy Three is wrong?' }).click();
  const check = page.getByRole('group', { name: 'Number check for Dummy Three' });
  await expect(check.getByRole('button', { name: 'Send to Biz Ops' })).toBeDisabled();
  await check.getByLabel('What should it be?').fill('3');
  await check.getByLabel('What do you know?').fill('Two calls before Cadence');
  await check.getByRole('button', { name: 'Send to Biz Ops' }).click();
  await expect(prospects.getByText('Sent to Biz Ops')).toBeVisible();

  await page.getByRole('group', { name: 'Products' }).getByText('Acubooth', { exact: true }).click();
  await page.getByRole('button', { name: 'Add meeting', exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+$/);
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);

  await signIn(page, 'admin@cadence.local', 'admin12345');
  // The open check shows on Meetings in the sidebar.
  await expect(page.locator('aside').getByRole('link', { name: /Meetings/ })).toContainText(/\d/);
  await page.goto('/meetings/checks');
  const row = page.getByRole('row').filter({ hasText: 'Dummy Three' }).filter({ hasText: 'E2E number check' }).first();
  await expect(row).toContainText('Two calls before Cadence');
  await expect(row).toContainText('3rd meeting');
  await row.getByRole('link', { name: 'Check', exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/checks\/[0-9a-f-]+$/);

  // Set on the meeting it was raised about; the meetings after it count on from there.
  const number = page.getByLabel(/^Number for E2E number check/);
  await number.fill('3');
  await number.locator('xpath=..').getByRole('button', { name: 'Set' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'E2E number check' })).toContainText('3rd meeting');
  await expect(page.getByText('Set by Biz Ops').first()).toBeVisible();

  await page.getByLabel('What you found').fill('Confirmed two calls in September.');
  await page.getByRole('button', { name: 'Close check' }).click();
  await expect(page).toHaveURL(/\/meetings\/checks$/);
  await page.goto('/meetings/checks?tab=closed');
  await expect(page.getByRole('row').filter({ hasText: 'Dummy Three' }).first()).toContainText('Confirmed two calls in September.');
});
