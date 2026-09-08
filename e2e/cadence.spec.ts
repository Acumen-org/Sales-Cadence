import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end flows an FO and a manager actually perform, against the seeded demo workspace.
 * Runs serially: later tests build on the campaign created earlier.
 */
test.describe.configure({ mode: 'serial' });

async function loginAs(page: Page, name: 'Admin' | 'Alisa' | 'Leigh' | 'Karson') {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page).toHaveURL(/\/home/);
}

async function logout(page: Page) {
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);
}

const isWeekend = () => [0, 6].includes(new Date().getDay());

test('login page offers one-click demo sign-in and lands on Home', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('Demo workspace: sign in as')).toBeVisible();
  await page.getByRole('button', { name: /^Alisa/ }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole('heading', { name: /Good day, Alisa/ })).toBeVisible();
  await expect(page.getByText('Calls today')).toBeVisible();
  await logout(page);
});

test('anonymous visitors are redirected to login', async ({ page }) => {
  await page.goto('/tasks');
  await expect(page).toHaveURL(/\/login\?next=/);
});

test('a Senior FO creates a campaign with a conflict preview', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/campaigns/new');
  await page.getByLabel('Name', { exact: true }).fill('E2E SaaStr follow-up');
  await page.getByLabel('Pod', { exact: true }).selectOption({ label: "Alisa's pod (ALISA)" });
  // Dummy Six is dnd in the demo workspace: it must be listed as skipped, not enrolled
  await page.getByLabel('Twenty person ids').fill('dummy-01\ndummy-02\ndummy-03\ndummy-04\ndummy-06');
  await page.getByRole('button', { name: 'Preview conflicts' }).click();
  await expect(page.getByText(/4 will be enrolled, 1 skipped/)).toBeVisible();
  await expect(page.getByText('Do not contact', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Create campaign and enrol 4/ }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+$/);
  await expect(page.getByText('Enrollments (4)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'E2E SaaStr follow-up' })).toBeVisible();
  await logout(page);
});

test('the same person cannot be enrolled twice', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/campaigns/new');
  await page.getByLabel('Name', { exact: true }).fill('E2E duplicate check');
  await page.getByLabel('Twenty person ids').fill('dummy-01');
  await page.getByRole('button', { name: 'Preview conflicts' }).click();
  await expect(page.getByText(/0 will be enrolled, 1 skipped/)).toBeVisible();
  await expect(page.getByText('Already in a sequence')).toBeVisible();
  await expect(page.getByRole('button', { name: /Create campaign/ })).toBeDisabled();
  await logout(page);
});

test('task flow: complete an email, log a call with an outcome, skip with a bounce', async ({ page }) => {
  await loginAs(page, 'Alisa');
  // Weekend start dates roll to Monday, so the first tasks may be "upcoming" rather than "today".
  const tab = isWeekend() ? 'upcoming' : 'today';
  await page.goto(`/tasks?tab=${tab}&fo=`);
  await expect(page.getByText(/Email 1/).first()).toBeVisible();

  // Task flow, emails only. The heading is the person; the step is in the line above it.
  await page.goto(`/tasks?tab=${tab}&type=EMAIL&mode=flow`);
  await expect(page.getByText(/Step \d+ of \d+/)).toBeVisible();
  const firstPerson = (await page.locator('main h2').first().textContent())!.trim();
  await expect(page.locator('input[id^="subject-"]').first()).toBeVisible(); // template rendered
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('status').or(page.getByText(/Step \d+ of \d+/))).toBeVisible();
  // the completed task no longer appears in the pending email list
  await page.goto(`/tasks?tab=${tab}&type=EMAIL`);
  await expect(page.getByRole('link', { name: new RegExp(firstPerson) }).first()).toHaveCount(0);

  // Done tab shows it as manual
  await page.goto('/tasks?tab=done');
  await expect(page.getByRole('link', { name: new RegExp(firstPerson) }).first()).toBeVisible();

  // LinkedIn connect for the same person: complete it so step 2 (Call 1) is generated
  await page.goto(`/tasks?tab=${tab}&type=LINKEDIN`);
  await page.getByRole('link', { name: new RegExp(firstPerson) }).first().click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/Done\./);

  // The call is now upcoming (day 3). Log it with an outcome.
  await page.goto('/tasks?tab=upcoming&type=CALL');
  await page.getByRole('link', { name: new RegExp(firstPerson) }).first().click();
  await expect(page.getByText(/Call 1/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Log call' }).click();
  await expect(page.getByText('How did the call go?')).toBeVisible();
  // submit without an outcome must be blocked
  await expect(page.getByRole('button', { name: 'Log call' }).last()).toBeDisabled();
  await page.getByText('Left voicemail').click();
  await page.getByLabel(/Call notes/).fill('Voicemail left, try again Thursday');
  await page.getByRole('button', { name: 'Log call' }).last().click();
  await expect(page.getByText(/Call logged/)).toBeVisible();

  // Skip with a bounce on another person: the enrollment ends as Bounced
  await page.goto(`/tasks?tab=${tab}&type=EMAIL`);
  const secondLink = page.getByRole('link', { name: /Email 1/ }).first();
  const secondPerson = (await secondLink.locator('span.font-medium').first().textContent())!.trim();
  await secondLink.click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByLabel('Why?', { exact: true }).selectOption('bounced');
  await page.getByRole('button', { name: 'Skip step' }).click();
  await expect(page.getByText(/Skipped and removed from the sequence \(bounced\)/)).toBeVisible();

  // Person page reflects it
  await page.goto('/people?q=' + encodeURIComponent(secondPerson.split(' ')[1] ?? secondPerson));
  await page.getByRole('link', { name: secondPerson }).click();
  await expect(page.getByText('Bounced').first()).toBeVisible();
  await expect(page.getByText('bad email')).toBeVisible();
  await logout(page);
});

test('answered call finishes the sequence as replied and shows on Home', async ({ page }) => {
  await loginAs(page, 'Alisa');
  const tab = isWeekend() ? 'upcoming' : 'today';
  // Take a fresh person still on Email 1 through both step-1 tasks, then answer the call
  await page.goto(`/tasks?tab=${tab}&type=EMAIL`);
  const link = page.getByRole('link', { name: /Email 1/ }).first();
  const person = (await link.locator('span.font-medium').first().textContent())!.trim();
  await link.click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText(/Done\./).first()).toBeVisible();
  await page.goto(`/tasks?tab=${tab}&type=LINKEDIN`);
  await page.getByRole('link', { name: new RegExp(person) }).first().click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText(/Done\./).first()).toBeVisible();
  await page.goto('/tasks?tab=upcoming&type=CALL');
  await page.getByRole('link', { name: new RegExp(person) }).first().click();
  await page.getByRole('button', { name: 'Log call' }).click();
  await page.getByText('Connected', { exact: true }).click();
  await page.getByRole('button', { name: 'Log call' }).last().click();
  await expect(page.getByText(/answered, so the sequence is finished as replied/)).toBeVisible();
  // Home counts this as a reply for the FO who owns the enrollment. The "Replies this week" box
  // is about inbound emails Twenty synced, so a logged call belongs in the team column, not there.
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: /this week/ })).toBeVisible();
  // The enrollment's own FO gets the credit, so somebody in the pod table has a reply this week.
  const replyCells = await page.locator('table tbody tr td:nth-child(5)').allTextContents();
  expect(replyCells.some((v) => Number(v.trim()) > 0)).toBe(true);
  // And the person is finished as replied.
  await page.goto('/people?q=' + encodeURIComponent(person.split(' ')[1] ?? person));
  await page.getByRole('link', { name: person }).click();
  await expect(page.getByText('Replied').first()).toBeVisible();
  await logout(page);
});

test('sequence page shows the funnel and the editor creates a new version', async ({ page }) => {
  await loginAs(page, 'Admin');
  await page.goto('/sequences');
  await page.getByRole('link', { name: 'Default outbound (23 days)' }).click();
  await expect(page.getByText('Steps and funnel')).toBeVisible();
  await expect(page.getByText(/Email 1/).first()).toBeVisible();
  await page.getByRole('link', { name: /Edit \(new version\)/ }).click();
  await page.getByPlaceholder(/Softer Email 2/).fill('e2e: renamed email 3');
  const labels = page.getByLabel('Label');
  await labels.last().fill('Email 3 (final)');
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByText(/Saved as version 2/)).toBeVisible();
  await page.goto(page.url().replace(/\?.*$/, '') + '?tab=versions');
  await expect(page.getByText('Version 2')).toBeVisible();
  await logout(page);
});

test('admin saves rules; a junior FO cannot open settings', async ({ page }) => {
  await loginAs(page, 'Admin');
  await page.goto('/settings?tab=rules');
  const cap = page.getByLabel(/Daily cap/);
  await cap.fill('35');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Rules saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Daily cap/)).toHaveValue('35');
  await logout(page);

  await loginAs(page, 'Karson');
  await page.goto('/settings');
  await expect(page).not.toHaveURL(/\/settings/);
  await page.goto('/tasks');
  await expect(page.getByText('All pods')).toHaveCount(0); // no pod filter for juniors
  await page.goto('/reports');
  await expect(page).not.toHaveURL(/\/reports/);
  await logout(page);
});

test('reports and people pages render with data', async ({ page }) => {
  await loginAs(page, 'Admin');
  await page.goto('/reports');
  await expect(page.getByText('Last 7 days')).toBeVisible();
  await page.goto('/reports?tab=pods');
  await expect(page.getByText("Alisa's pod")).toBeVisible();
  // The people list is filtered on what Twenty holds, and shows it as Twenty's own labels.
  await page.goto('/people?tier=LEVEL_1');
  await expect(page.locator('table').getByText('Tier 1', { exact: true }).first()).toBeVisible();
  await page.goto('/people?list=COLD_BD');
  await expect(page.locator('table').getByText('Cold BD', { exact: true }).first()).toBeVisible();
  // No option constant ever reaches the screen.
  await expect(page.locator('table').getByText(/^[A-Z][A-Z0-9]+_[A-Z0-9_]+$/)).toHaveCount(0);
  await page.goto('/people?q=One');
  await page.getByRole('link', { name: 'Dummy One' }).click();
  await expect(page.getByRole('heading', { name: 'Dummy One' })).toBeVisible();
  // Scoped to the record: "Activity" is also a nav item now.
  await expect(page.locator('main').getByText('Activity', { exact: true }).first()).toBeVisible();
  // pods discovered from Twenty show up in Settings for the admin to staff
  await page.goto('/settings?tab=users');
  await expect(page.getByText('discovered from Twenty')).toBeVisible();
  await expect(page.getByText("Alisa's pod", { exact: true }).first()).toBeVisible();
  await logout(page);
});
