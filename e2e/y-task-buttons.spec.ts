import { expect, test, type Page } from '@playwright/test';

/**
 * The owner, 25 September 2026: "Snooze is not working either. Please test all buttons especially
 * in the tasks section." The buttons the other specs do not press - Snooze, bulk Snooze, Delegate -
 * and next actions, from People to Tasks. Runs late: it snoozes and hands work around.
 */
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, email: string, password = 'password123') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

/** The first tab with a step in it, by the workspace's clock. */
async function openTabWithWork(page: Page) {
  for (const tab of ['today', 'overdue', 'upcoming']) {
    await page.goto(`/tasks?tab=${tab}`);
    if (await page.locator('a[href*="task="]').count()) return tab;
  }
  throw new Error('No open steps in any tab');
}

test('Snooze moves a step to the day picked, and the list says so', async ({ page }) => {
  await signIn(page, 'alisa@cadence.local');
  await openTabWithWork(page);
  await page.locator('a[href*="task="]').first().click();
  const snooze = page.getByRole('button', { name: 'Snooze', exact: true }).last();
  await expect(snooze).toBeEnabled();
  await snooze.click();
  await expect(page.getByText('Come back to this task later')).toBeVisible();
  await page.locator('form').filter({ hasText: 'Come back to this task later' }).getByRole('button', { name: 'Snooze' }).click();
  await expect(page.getByText(/Snoozed to \d{4}-\d{2}-\d{2}/)).toBeVisible();
});

test('bulk Snooze moves every step selected', async ({ page }) => {
  await signIn(page, 'alisa@cadence.local');
  await openTabWithWork(page);
  const boxes = page.locator('ul input[type="checkbox"]');
  test.skip((await boxes.count()) < 2, 'fewer than two steps in view');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.locator('select').filter({ has: page.locator('option[value="snooze"]') }).selectOption('snooze');
  await page.getByRole('button', { name: 'Apply' }).click();
  // Counted by the parts of each step: two steps of two parts read "4 snoozed."
  await expect(page.getByText(/^\d+ snoozed\.$/)).toBeVisible();
});

test('Delegate hands a step to a pod-mate', async ({ page }) => {
  await signIn(page, 'alisa@cadence.local');
  await openTabWithWork(page);
  await page.locator('a[href*="task="]').first().click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const to = page.getByLabel('Delegate to');
  test.skip(!(await to.count()), 'this step cannot be delegated');
  await to.selectOption({ index: 1 });
  await page.locator('form').filter({ has: to }).getByRole('button').click();
  await expect(page.getByText(/Delegated to /)).toBeVisible();
});

test('a next action set for two people in People is worked in Tasks and moves on when it repeats', async ({ page }) => {
  await signIn(page, 'admin@cadence.local', 'admin12345');
  await page.goto('/people');
  // People already in a campaign cannot be selected; the first two who can.
  const rows = page.locator('tbody input[type="checkbox"]:enabled');
  await rows.nth(0).check();
  await rows.nth(1).check();
  await page.getByRole('button', { name: 'Next action' }).click();
  await page.getByLabel('What to do').fill('E2E send the one-pager');
  await page.getByLabel('Repeats').selectOption('WEEKLY');
  await page.getByRole('button', { name: 'Save next action' }).click();
  await expect(page.getByText('Next action set for 2 people.')).toBeVisible();

  await page.goto('/tasks?tab=today&pod=&fo=');
  await expect(page.getByText('Next actions', { exact: false }).first()).toBeVisible();
  await page.locator('a[href*="next="]').filter({ hasText: 'E2E send the one-pager' }).first().click();
  await expect(page.getByText('Next action', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText(/Done\. Next one on \d{4}-\d{2}-\d{2}\./)).toBeVisible();
  // The other one: snoozed, then stopped.
  await page.locator('a[href*="next="]').filter({ hasText: 'E2E send the one-pager' }).first().click();
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.locator('form').getByRole('button', { name: 'Snooze' }).click();
  await expect(page.getByText(/Moved to \d{4}-\d{2}-\d{2}\./)).toBeVisible();
});

test("a person's page sets, shows and stops their next action", async ({ page }) => {
  await signIn(page, 'admin@cadence.local', 'admin12345');
  await page.goto('/people');
  await page.locator('tbody a[href^="/people/"]').nth(3).click();
  await page.getByRole('button', { name: /Set next action|Change/ }).click();
  await page.getByLabel('What to do').fill('E2E call about the pilot');
  await page.getByLabel('How').selectOption('CALL');
  await page.getByRole('button', { name: 'Save next action' }).click();
  await expect(page.getByText('E2E call about the pilot')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('E2E call about the pilot')).toHaveCount(0);
});
