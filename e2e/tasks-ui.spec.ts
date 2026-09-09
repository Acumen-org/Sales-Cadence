import { expect, test, type Page } from '@playwright/test';

/**
 * How the Tasks screen behaves after the rework: one action row, one panel slot, an editable
 * message, a person panel that carries the CRM record, and a task flow that is a different way
 * of working rather than the same layout with the list hidden.
 */
test.describe.configure({ mode: 'serial' });

async function loginAs(page: Page, name: 'Admin' | 'Alisa') {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page).toHaveURL(/\/home/);
}

async function logout(page: Page) {
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);
}

/**
 * Open the first task tab that has work in it. The suite shares one database, so which tab holds
 * a pending task depends on what earlier cases did; the point of these cases is the controls,
 * not which tab the work happens to be in.
 */
async function openTabWithWork(page: Page) {
  for (const tab of ['today', 'overdue', 'upcoming']) {
    await page.goto(`/tasks?tab=${tab}`);
    if (await page.getByRole('button', { name: 'More', exact: true }).first().isVisible().catch(() => false)) return;
  }
  throw new Error('No task tab has pending work; the seed or an earlier case cleared them all.');
}

test('the header carries no counts, and no overdue banner interrupts the list', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/tasks?tab=today');
  await expect(page.locator('main')).not.toContainText(/\d+ results? ·/);
  await expect(page.locator('main')).not.toContainText('Overdue work is never dropped');
  // The tab still reports the overdue count, which is where a count belongs.
  await expect(page.getByRole('link', { name: /^Overdue \d+$/ })).toBeVisible();
  await logout(page);
});

test('More becomes Less without moving, and everything opens in one place', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/tasks?tab=today');

  // Measured in page coordinates: opening the panel may scroll the viewport, which is not
  // the same thing as the button moving.
  const pagePos = async (label: string) => {
    const box = await page.getByRole('button', { name: label, exact: true }).first().boundingBox();
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    return { x: (box?.x ?? 0) + scroll.x, y: (box?.y ?? 0) + scroll.y };
  };

  const before = await pagePos('More');
  await page.getByRole('button', { name: 'More', exact: true }).first().click();
  const less = page.getByRole('button', { name: 'Less', exact: true }).first();
  await expect(less).toBeVisible();
  const after = await pagePos('Less');
  // Same button, same place: only the word changes.
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);

  // The two things it reveals, both inside the one panel.
  await expect(page.getByText('End the sequence')).toBeVisible();
  await expect(page.getByText('Jump to another step')).toBeVisible();
  // Gone for good: pause, and the two "Finished (...)" buttons nobody could read.
  await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  await expect(page.getByText(/Finish \(/)).toHaveCount(0);

  await less.click();
  await expect(page.getByText('End the sequence')).toHaveCount(0);
  await logout(page);
});

test('the shortcut list is gone from under the buttons', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/tasks?tab=today');
  await expect(page.locator('main')).not.toContainText('next/previous');
  await expect(page.locator('main')).not.toContainText('Shortcuts:');
  // They still work, and the help button still lists them.
  await page.getByLabel('Help').click();
  await expect(page.getByText('Task flow shortcuts')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Task flow shortcuts')).toHaveCount(0);
  await logout(page);
});

test('the message is editable in place and the edit is kept against the task', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/tasks?tab=today&type=EMAIL');
  const subject = page.getByLabel('Email subject').first();
  await expect(subject).toBeVisible();
  const original = await subject.inputValue();
  expect(original.length).toBeGreaterThan(0);

  await subject.fill('Following up after the webinar');
  const body = page.getByRole('textbox', { name: /message$/i }).first();
  await body.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' PS one more thing.');
  // Saved on the server against this task, not in this browser.
  await expect(page.getByRole('button', { name: 'Saved', exact: true }).first()).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await expect(page.getByLabel('Email subject').first()).toHaveValue('Following up after the webinar');
  await expect(page.locator('main')).toContainText('PS one more thing.');
  await logout(page);
});

test('the person panel carries the CRM record, not a made-up stage', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/tasks?tab=today');
  const panel = page.locator('aside');

  // "Approaching" was a label Cadence invented; it is gone.
  await expect(panel.getByText('Approaching')).toHaveCount(0);
  // What the CRM holds, in the CRM's own terms: the record, its own next action, its tags.
  for (const section of ['Contact details', 'CRM profile', 'CRM tags', 'Sequence progress', 'Recent activity']) {
    await expect(panel.getByText(section, { exact: true }).first(), section).toBeVisible();
  }
  // The CRM's own next action appears for the people who have one written in Twenty.
  await page.goto('/people/dummy-01?tab=overview');
  await expect(page.locator('main')).toContainText('FU-2');
  await page.goto('/tasks?tab=today');
  // The tier is a badge on the person, reading as a label rather than the stored LEVEL_n.
  await expect(panel.getByText(/^Tier \d$/).first()).toBeVisible();
  // Option constants are never shown raw: LEVEL_2 reads "Tier 2", not "LEVEL_2".
  await expect(panel.getByText(/^[A-Z][A-Z0-9]+_[A-Z0-9_]+$/)).toHaveCount(0);
  // The assistant has a reserved place and says plainly that no model is connected.
  await expect(panel.getByText('Cadence AI').first()).toBeVisible();
  await expect(panel.getByText(/No model provider is connected/)).toBeVisible();
  await logout(page);
});

test('task flow is a different screen from the list', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/tasks?tab=today');
  // List: a table of tasks to pick from.
  await expect(page.getByLabel(/^Select /).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Task flow', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Task flow', exact: true }).click();
  await expect(page).toHaveURL(/mode=flow/);
  // Flow: no list, a progress rail, and a way back.
  await expect(page.getByLabel(/^Select /)).toHaveCount(0);
  await expect(page.getByText(/^Task flow$/).first()).toBeVisible();
  await expect(page.getByText(/^\d+ \/ \d+$/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to list' })).toBeVisible();
  await logout(page);
});

test('jumping to a step confirms with a toast that says only what happened', async ({ page }) => {
  await loginAs(page, 'Admin');
  // Earlier cases in the run may have cleared a tab, so work the first one that has something.
  await openTabWithWork(page);
  await page.getByRole('button', { name: 'More', exact: true }).first().click();
  await page.getByLabel('Step to jump to').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Jump' }).click();

  const toast = page.getByRole('status');
  await expect(toast).toContainText(/Moved to step \d+\./);
  // The old message trailed "2 tasks due now.", which nobody asked for.
  await expect(toast).not.toContainText('due now');
  await logout(page);
});

test('ending a sequence asks one question and then stops the person', async ({ page }) => {
  await loginAs(page, 'Admin');
  await page.goto('/tasks?tab=upcoming');
  const person = await page.locator('#main-content a[href^="/people/"]').first().textContent();
  await page.getByRole('button', { name: 'More', exact: true }).first().click();
  await page.getByLabel('Why are you ending the sequence?').selectOption('not_interested');
  await page.getByRole('button', { name: 'End sequence' }).click();
  await expect(page.getByRole('status')).toContainText(/Sequence ended/);

  // That person no longer has work due. Scoped to the list: their name still appears in the
  // "colleagues" list of whoever is selected next, which is correct.
  await page.goto('/tasks?tab=upcoming');
  if (person) await expect(page.getByLabel(`Select ${person.trim()}`)).toHaveCount(0);
  await logout(page);
});
