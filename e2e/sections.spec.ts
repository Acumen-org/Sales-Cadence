import { expect, test, type Page } from '@playwright/test';

/**
 * The sections added for meetings, accounts and activity, plus the Home and chrome rules:
 * Personal priorities, weekly team performance, global utilities and role-aware navigation.
 */
test.describe.configure({ mode: 'serial' });

async function loginAs(page: Page, name: 'Admin' | 'Alisa' | 'Karson') {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page).toHaveURL(/\/home/);
}

async function logout(page: Page) {
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);
}

test('Home greets the signed-in user and opens personal work from its priorities', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await expect(page.getByRole('heading', { name: 'Good day, Alisa' })).toBeVisible();

  for (const label of ['To reach today', 'Completed today', 'Calls today', 'Emails today', 'LinkedIn today', 'My accounts', 'My relationships']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Up next' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: "Today's progress" })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your pods this week' })).toBeVisible();
  await logout(page);
});

test('the team board reports this week, with a total row', async ({ page }) => {
  await loginAs(page, 'Admin');
  await expect(page.getByRole('heading', { name: 'The team this week' })).toBeVisible();
  const headers = page.locator('table thead th');
  await expect(headers.nth(0)).toHaveText('Person');
  await expect(headers.nth(1)).toHaveText('Due today');
  await expect(headers.nth(2)).toHaveText('Overdue');
  await expect(headers.nth(3)).toHaveText('Done this week');
  await expect(headers.nth(4)).toHaveText('Replies');
  await expect(headers.nth(5)).toHaveText('Meetings');
  await expect(page.getByText('In sequence')).toHaveCount(0);
  await expect(page.getByText(/\(7d\)/)).toHaveCount(0);
  // Everyone's totals, and a link into each person's tasks.
  await expect(page.locator('table tfoot')).toContainText('Everyone');
  await expect(page.getByRole('link', { name: /^Tasks$/ }).first()).toBeVisible();
  await logout(page);
});

test('search and help are available from every workspace section', async ({ page }) => {
  await loginAs(page, 'Alisa');
  const header = page.locator('.workspace-topbar');
  for (const path of ['/home', '/accounts', '/people', '/meetings', '/campaigns', '/activity']) {
    await page.goto(path);
    await expect(header.getByLabel('Help')).toBeVisible();
    await expect(header.getByLabel('Search')).toBeVisible();
    await expect(header.getByLabel('Overdue tasks')).toBeVisible();
  }
  await page.goto('/tasks');
  await expect(header.getByLabel('Search')).toBeVisible();
  await expect(header.getByLabel('Help')).toBeVisible();
  await logout(page);
});

test('Settings is admin-only, in the sidebar and by URL', async ({ page }) => {
  await loginAs(page, 'Karson');
  await expect(page.locator('aside').getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(page.locator('aside').getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await page.goto('/settings');
  await expect(page).not.toHaveURL(/\/settings/);
  await logout(page);

  await loginAs(page, 'Admin');
  await expect(page.locator('aside').getByRole('link', { name: 'Settings' })).toBeVisible();
  await logout(page);
});

test('a meeting plays in the app with its transcript and an empty analysis panel', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/meetings/new');
  await page.getByLabel('Title').fill('E2E discovery call');
  await page.getByLabel('Recording or meeting link').fill('https://files.example.com/e2e/recording.mp4');
  // The form says what it can do with the link before saving.
  await expect(page.getByText(/Media file/)).toBeVisible();
  await page.getByLabel('When').fill('2026-09-08T10:00');
  await page.getByLabel('Duration (minutes)').fill('18');
  await page.getByLabel('Attendees').fill('Dummy One <dummy.one@dummy-a.example>\nalisa@acumen-strategy.com');
  await page.getByLabel('Transcript (optional)').fill('WEBVTT\n\n00:00:01.000 --> 00:00:06.000\n<v Alisa Senior>Thanks for making the time today.\n\n00:00:07.000 --> 00:00:12.000\n<v Dummy One>Happy to. Tell me about the reporting pack.\n');
  await page.getByRole('button', { name: /Add meeting|Save/ }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+$/);

  // Plays inline: a real <video> element, not a link-out.
  await expect(page.locator('video')).toHaveCount(1);
  // Transcript underneath, with speakers.
  await expect(page.getByText('Thanks for making the time today.')).toBeVisible();
  await expect(page.getByText('Dummy One').first()).toBeVisible();
  // Analysis panel: deliberately empty until a model is connected.
  await expect(page.getByText('No analysis yet')).toBeVisible();

  // One external attendee, so it counts as booked this week.
  await page.goto('/meetings?scope=week');
  await expect(page.getByRole('link', { name: /E2E discovery call/ })).toBeVisible();
  // The first table is the list of meetings in Cadence; "Recordings in Twenty" is a second one.
  await expect(page.locator('table').first()).toContainText('external');
  await logout(page);
});

test('a Zoom recording link is offered as a link-out, not a broken frame', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/meetings/new');
  await page.getByLabel('Title').fill('E2E zoom review');
  await page.getByLabel('Recording or meeting link').fill('https://acme.zoom.us/rec/share/e2e');
  await expect(page.getByText(/blocks embedding/)).toBeVisible();
  await page.getByLabel('When').fill('2026-09-08T14:00');
  await page.getByRole('button', { name: /Add meeting|Save/ }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+$/);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open in Zoom|Open recording/ }).first()).toBeVisible();
  await logout(page);
});

test('an account shows its people, hierarchy and one timeline', async ({ page }) => {
  await loginAs(page, 'Admin');
  await page.goto('/accounts');
  await expect(page.getByRole('link', { name: 'Dummy Company A' })).toBeVisible();
  await page.getByRole('link', { name: 'Dummy Company A' }).click();
  await expect(page).toHaveURL(/\/accounts\//);
  await expect(page.getByRole('heading', { name: 'Dummy Company A' })).toBeVisible();

  await page.getByRole('link', { name: 'Relationship map' }).click();
  // The seeded chart puts Dummy Two and Dummy Three under Dummy One.
  await expect(page.getByRole('link', { name: 'Dummy One' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dummy Two' })).toBeVisible();
  await expect(page.getByText('Champion').first()).toBeVisible();

  await page.locator('main').getByRole('link', { name: 'People', exact: true }).click();
  // The people table names each person's manager.
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.locator('table')).toContainText('Dummy One');

  await page.getByRole('link', { name: 'Timeline' }).click();
  await expect(page.locator('main')).toContainText(/Email|Call|Meeting|enrolled/i);
  await logout(page);
});

test('the relationship map can be edited and refuses to make a loop', async ({ page }) => {
  await loginAs(page, 'Admin');
  await page.goto('/accounts');
  await page.getByRole('link', { name: 'Dummy Company B' }).click();
  await page.getByRole('link', { name: 'Relationship map' }).click();

  // Change a stance: the chart itself is the confirmation. Nobody here starts as a detractor.
  await expect(page.locator('main')).not.toContainText('Detractor');
  await page.getByRole('button', { name: 'Edit Dummy Eleven' }).click();
  await page.getByLabel('Stance').selectOption('DETRACTOR');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.locator('main')).toContainText('Detractor');

  // Dummy Five already reports to Dummy Four, so pointing Four at Five would loop.
  await page.getByRole('button', { name: 'Edit Dummy Four', exact: true }).click();
  await page.getByLabel('Reports to').selectOption('dummy-05');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('That would create a loop in the reporting line.')).toBeVisible();
  await logout(page);
});

test('Activity lists work in time order and hides administration', async ({ page }) => {
  await loginAs(page, 'Admin');
  // Something administrative to prove it is filtered out.
  await page.goto('/settings?tab=rules');
  await page.getByLabel(/Daily cap/).fill('37');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Rules saved.')).toBeVisible();

  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Rules saved');
  await expect(page.locator('main')).not.toContainText('dailyCap');
  // "Settings" only exists in the sidebar, never as a feed row.
  await expect(page.locator('main').getByText(/^Settings/)).toHaveCount(0);

  // Filters are real query state.
  await page.getByRole('button', { name: 'Emails and calls' }).click();
  await expect(page).toHaveURL(/kind=touch/);
  await expect(page.locator('main')).toContainText(/Email|Call/);
  await logout(page);
});

test('per-user views: my accounts and my relationships', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/home');
  await page.getByRole('link', { name: /My accounts/ }).click();
  await expect(page).toHaveURL(/\/accounts\?scope=mine/);
  await expect(page.locator('table tbody tr').first()).toBeVisible();

  await page.goto('/home');
  await page.getByRole('link', { name: /My relationships/ }).click();
  await expect(page).toHaveURL(/\/people\?owner=mine/);
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await logout(page);
});

test('the person record shows the real Twenty fields, grouped as Twenty groups them', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/people/dummy-01?tab=details');
  const main = page.locator('main');

  // The four groups the CRM record has, in that order.
  for (const card of ['Contact details', 'Ownership', 'Classification', 'Next action, as Twenty holds it']) {
    await expect(main.getByText(card, { exact: true })).toBeVisible();
  }

  // Ownership comes from assignedTo and podOwner, not from an invented owner field.
  await expect(main.getByText('Alisa Senior').first()).toBeVisible();
  await expect(main.getByText("Alisa's pod").first()).toBeVisible();

  // Classification, with every option rendered as a label rather than a constant.
  await expect(main.getByText('Tier 1').first()).toBeVisible();
  await expect(main.getByText('Prospect').first()).toBeVisible();
  await expect(main.getByText(/Bi-weekly \(was Monthly\)/)).toBeVisible();
  await expect(main.getByText('FPA Wisconsin July 2026')).toBeVisible();
  await expect(main.getByText('AY PHH post-webinar')).toBeVisible();
  await expect(main.getByText(/^[A-Z][A-Z0-9]+_[A-Z0-9_]+$/)).toHaveCount(0);

  // Twenty's own next action, which Cadence reads and never overwrites.
  await expect(main.getByText('FU-2', { exact: true })).toBeVisible();
  await expect(main.getByText('FU 1 done, asked for the PHH one-pager.')).toBeVisible();
  await logout(page);
});

test('recordings Twenty holds are offered for adding, pre-filled', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/meetings');
  await expect(page.getByText('Recordings in Twenty')).toBeVisible();
  const row = page.locator('table').filter({ hasText: 'Dummy Four' }).first();
  await expect(row).toContainText('recording');

  // Adding one starts from the person record: link, account and attendee are filled in. The FO
  // still says when it happened - Twenty has no meeting time and Cadence does not invent one.
  await page.goto('/meetings/new?personId=dummy-04');
  await expect(page.getByLabel('Title')).toHaveValue(/Dummy Four/);
  await expect(page.getByLabel('Recording or meeting link')).toHaveValue(/ForBiggerMeetings\.mp4/);
  await expect(page.getByLabel('Attendees')).toHaveValue(/dummy\.four@dummy-b\.example/);
  await expect(page.getByText(/Media file/)).toBeVisible();
  await logout(page);
});
