import { expect, test, type Page } from '@playwright/test';

/**
 * Owner, 20 November 2026.
 *  - A meeting with no recording link waits for the Sales Leader of the booking FO's pod, under
 *    Meetings > Waiting for approval; a decline asks why, takes it out, and Biz Ops can add it back.
 *  - A reached call can end with no next step, but the form asks why (Alyssa's one-off call).
 */
const PASSWORD = 'password123';

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}
async function signOut(page: Page) {
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);
}
async function sound(page: Page) {
  const body = await page.locator('body').innerText();
  expect(body, page.url()).not.toContain('Application error');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${page.url()} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
}

test('a meeting with no recording waits for the Sales Leader, who declines it; Biz Ops adds it back', async ({ page }) => {
  const title = `E2E no recording ${Date.now()}`;
  await signIn(page, 'karson@cadence.local');
  await page.goto('/meetings/new');
  await page.getByLabel('Not recorded or in person').check();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Date', { exact: true }).fill('2026-10-06');
  await page.getByRole('combobox', { name: 'Find a prospect in the CRM' }).fill('Dummy Four');
  await page.getByRole('listbox', { name: 'Find a prospect in the CRM results' }).getByRole('option', { name: /^Dummy Four / }).click({ timeout: 20_000 });
  await page.getByRole('group', { name: 'Products' }).getByText('Acubooth', { exact: true }).click();
  await page.getByRole('button', { name: 'Add meeting', exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+$/);
  const approval = page.getByRole('region', { name: 'Approval' });
  await expect(approval).toContainText('Waiting for approval.');
  await expect(approval).toContainText('Leigh Leader approves or declines it');
  await expect(approval.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  // An FO has no Approval tabs, and the address sends them back to Meetings.
  await page.goto('/meetings');
  await expect(page.getByRole('link', { name: /Waiting for approval/ })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: title })).toContainText('Waiting for approval');
  await page.goto('/meetings/approval');
  await expect(page).toHaveURL(/\/meetings$/);
  await signOut(page);

  // The Sales Leader of Karson's pod: a count on Meetings, and the meeting under Waiting for approval.
  await signIn(page, 'leigh@cadence.local');
  await expect(page.locator('aside').getByRole('link', { name: /Meetings/ })).toContainText(/\d/);
  await page.goto('/meetings');
  await page.getByRole('link', { name: /Waiting for approval/ }).click();
  await expect(page).toHaveURL(/\/meetings\/approval$/);
  await sound(page);
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toContainText('Karson Junior');
  await row.getByRole('button', { name: 'Decline' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Its record in the CRM is removed.');
  await expect(dialog.getByRole('button', { name: 'Decline meeting' })).toBeDisabled();
  await dialog.getByLabel('Why are you declining it?').fill('No proof it took place');
  await dialog.getByRole('button', { name: 'Decline meeting' }).click();
  await expect(page.getByText(/Declined "E2E no recording/).first()).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: title })).toHaveCount(0);
  await page.getByRole('link', { name: /^Declined/ }).click();
  await expect(page.getByRole('row').filter({ hasText: title })).toContainText('No proof it took place');
  // Out of the list everyone reads.
  await page.goto('/meetings');
  await expect(page.getByRole('row').filter({ hasText: title })).toHaveCount(0);
  await signOut(page);

  // Biz Ops see the declined meetings (and decide nothing), and may add one back.
  await signIn(page, 'bea@cadence.local');
  await page.goto('/meetings/approval');
  await expect(page).toHaveURL(/\/meetings\/approval$/);
  await expect(page.getByRole('link', { name: /Waiting for approval/ })).toHaveCount(0);
  await sound(page);
  const declined = page.getByRole('row').filter({ hasText: title });
  await declined.getByRole('button', { name: 'Add back' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add it back' }).click();
  await expect(page.getByText(/Added "E2E no recording/).first()).toBeVisible();
  await page.goto('/meetings');
  await expect(page.getByRole('row').filter({ hasText: title })).toHaveCount(1);
});

test('a reached call can end with no next step, and the form asks why', async ({ page }) => {
  await signIn(page, 'alisa@cadence.local');
  await page.goto('/people?q=Dummy%20Five');
  await page.getByRole('link', { name: /Dummy Five/ }).first().click();
  await expect(page).toHaveURL(/\/people\/[^/?]+/);
  await page.getByRole('button', { name: 'Log a call' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  const form = page.getByRole('form', { name: /Form for your call with/ });
  await form.getByText('Connected', { exact: true }).click();
  await form.getByRole('button', { name: '5', exact: true }).click();
  await form.getByLabel(/What was said/).fill('Only wanted the event tickets');
  await form.getByLabel('Next step').selectOption('none');
  const why = form.getByLabel(/Why no next step/);
  await expect(why).toBeVisible();
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(form).toContainText('Say why there is no next step.');
  await why.fill('A one-off call about event tickets');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved. No next step is set.')).toBeVisible();
});
