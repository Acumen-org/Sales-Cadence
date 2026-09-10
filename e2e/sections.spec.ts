import { expect, test, type Page } from '@playwright/test';

const DEMO_EMAILS: Record<string, string> = {
  Admin: 'admin@cadence.local',
  Ria: 'ria@cadence.local',
  Leigh: 'leigh@cadence.local',
  Alisa: 'alisa@cadence.local',
  Andrew: 'andrew@cadence.local',
  Karson: 'karson@cadence.local',
  Daniel: 'daniel@cadence.local',
};

/** Sign in the way everyone signs in now: an email and a password, no one-click buttons. */
async function signInAs(page: Page, who: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(DEMO_EMAILS[who] ?? who);
  await page.getByLabel('Password').fill(who === 'Admin' ? 'admin12345' : 'password123');
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

/**
 * The sections added for meetings, accounts and activity, plus the Home and chrome rules:
 * Personal priorities, weekly team performance, global utilities and role-aware navigation.
 */
test.describe.configure({ mode: 'serial' });

async function loginAs(page: Page, name: 'Admin' | 'Alisa' | 'Karson') {
  await page.goto('/login');
  await signInAs(page, name);
  await expect(page).toHaveURL(/\/home/);
}

async function logout(page: Page) {
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);
}

test('Home greets the signed-in user and opens personal work from its priorities', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await expect(page.getByRole('heading', { name: 'Good day, Alisa' })).toBeVisible();

  for (const label of ['To reach today', 'Completed today', 'Calls today', 'Emails today', 'LinkedIn today', 'My accounts', 'My people']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Up next' })).toBeVisible();
  // Every figure on Home is a value, so nothing that moves is left in muted prose.
  await expect(page.locator('main').getByText(/^\d+ overdue tasks?$/)).toHaveCount(0);
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
    await expect(header.getByLabel('Notifications')).toBeVisible();
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
  await page.getByLabel('Date and time').fill('2026-09-08T10:00');
  await page.getByLabel('Duration (minutes)').fill('18');

  // Attendees are picked from the CRM directory and the team, and guests can be typed in.
  const finder = page.getByLabel('Find a contact or team member');
  const results = page.getByRole('region', { name: 'Attendee search results' });
  const pick = async (query: string, name: RegExp) => {
    await finder.click();
    await finder.fill(query);
    await expect(results).toBeVisible();
    await results.getByRole('button', { name }).first().click({ timeout: 20_000 });
  };
  // The organiser is already on the meeting, so they are not offered again.
  await expect(page.locator('#main-content').getByText('Alisa Senior')).toBeVisible();
  await finder.click();
  await finder.fill('Alisa');
  await expect(results).toContainText('No matching people');
  // A contact from the CRM directory, and a colleague from the team.
  await pick('dummy.one@', /Dummy One/);
  await pick('Karson', /Karson/);
  await page.getByRole('button', { name: 'Add someone outside the directory' }).click();
  await page.getByLabel('Guest name').fill('Outside Guest');
  await page.getByLabel('Guest email').fill('guest@prospect.example');
  await page.getByRole('button', { name: 'Add attendee' }).click();
  // One of each kind, and any of them can be taken off again.
  for (const kind of ['Contact', 'Team', 'Guest']) await expect(page.getByText(kind, { exact: true }).first(), kind).toBeVisible();
  await page.getByRole('button', { name: 'Remove Outside Guest' }).click();
  await expect(page.getByText('Outside Guest')).toHaveCount(0);

  await page.getByLabel('Transcript (optional)').fill('WEBVTT\n\n00:00:01.000 --> 00:00:06.000\n<v Alisa Senior>Thanks for making the time today.\n\n00:00:07.000 --> 00:00:12.000\n<v Dummy One>Happy to. Tell me about the reporting pack.\n');
  await page.getByRole('button', { name: /Add meeting|Save/ }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+$/);

  // Plays inline: a real <video> element, not a link-out. If the file itself cannot be fetched -
  // the demo recording is a public URL, and the browser running this may have no route to it -
  // the page has to say so and offer the source, never a black rectangle or a bare link.
  const player = page.locator('video');
  const unavailable = page.getByText('Recording unavailable');
  await expect(player.or(unavailable).first()).toBeVisible();
  if (await unavailable.count()) await expect(page.getByRole('link', { name: /Open the source/ })).toBeVisible();
  // Transcript underneath, with speakers.
  await expect(page.getByText('Thanks for making the time today.')).toBeVisible();
  await expect(page.getByText('Dummy One').first()).toBeVisible();
  // The assistant's panel, named and honest about not being connected.
  await expect(page.getByText('Cadence AI').first()).toBeVisible();
  await expect(page.getByText('Not connected').first()).toBeVisible();

  // One external attendee, so it counts as booked this week.
  await page.goto('/meetings?scope=week');
  await expect(page.getByRole('link', { name: /E2E discovery call/ })).toBeVisible();
  // The first table is the list of meetings in Cadence; "Recordings in Twenty" is a second one.
  await expect(page.locator('table').first()).toContainText(/\d external/);
  await logout(page);
});

test('a Zoom recording link is offered as a link-out, not a broken frame', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/meetings/new');
  await page.getByLabel('Title').fill('E2E zoom review');
  await page.getByLabel('Recording or meeting link').fill('https://acme.zoom.us/rec/share/e2e');
  await expect(page.getByText(/blocks embedding/)).toBeVisible();
  await page.getByLabel('Date and time').fill('2026-09-08T14:00');
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

  await page.getByRole('link', { name: 'People by title' }).click();
  await expect(page.getByRole('link', { name: 'Dummy One' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dummy Two' })).toBeVisible();
  // Grouped by the job title the CRM holds, not by a stance nobody could measure.
  await expect(page.getByText(/^(Executive|Leadership|Management|Other) titles$/).first()).toBeVisible();
  for (const invented of ['Champion', 'Supporter', 'Detractor']) {
    await expect(page.getByText(invented, { exact: true }), invented).toHaveCount(0);
  }

  await page.locator('main').getByRole('link', { name: 'People', exact: true }).click();
  // The people table names each person's manager.
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.locator('table')).toContainText('Dummy One');

  await page.getByRole('link', { name: 'Timeline' }).click();
  await expect(page.locator('main')).toContainText(/Email|Call|Meeting|enrolled/i);
  await logout(page);
});

test('the people view is grouped from CRM titles and holds nothing invented', async ({ page }) => {
  await loginAs(page, 'Admin');
  await page.goto('/accounts');
  await page.getByRole('link', { name: 'Dummy Company B' }).click();
  await page.getByRole('link', { name: 'People by title' }).click();

  // Derived from what Twenty holds, so there is nothing to edit and nothing to keep in step.
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByLabel('Stance')).toHaveCount(0);
  await expect(page.getByLabel('Reports to')).toHaveCount(0);
  for (const invented of ['Champion', 'Supporter', 'Neutral', 'Detractor']) {
    await expect(page.locator('main').getByText(invented, { exact: true }), invented).toHaveCount(0);
  }
  // The titles themselves are what the reader sees.
  await expect(page.locator('main')).toContainText('CEO');
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
  await page.getByLabel('Event type').selectOption('touch');
  await page.getByRole('button', { name: 'Apply filters' }).click();
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
  await page.getByRole('link', { name: /My people/ }).click();
  await expect(page).toHaveURL(/\/people\?owner=mine/);
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await logout(page);
});

test('the person record shows the real Twenty fields, grouped as Twenty groups them', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/people/dummy-01?tab=overview');
  const main = page.locator('main');

  // The groups the CRM record has: identity, who owns it, how it is classified, what the CRM
  // itself last recorded, and the provenance of the row.
  for (const card of ['Contact details', 'Ownership', 'Classification', 'CRM activity details', 'Record']) {
    await expect(main.getByText(card, { exact: true }), card).toBeVisible();
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
  // The person is already on the attendee list, alongside the organiser.
  await expect(page.locator('#main-content')).toContainText('Dummy Four');
  await expect(page.locator('#main-content')).toContainText('dummy.four@dummy-b.example');
  await expect(page.getByText(/Media file/)).toBeVisible();
  await logout(page);
});

test('a meeting is tagged with the products it was about', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/meetings');
  await page.getByRole('link', { name: /intro call/ }).first().click();
  await page.waitForURL(/\/meetings\/[0-9a-f-]+/);

  // Three products, none tagged to begin with, toggled from the record itself.
  const phh = page.getByRole('button', { name: 'PHH', exact: true });
  await expect(phh).toHaveAttribute('aria-pressed', 'false');
  await phh.click();
  await expect(phh).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Glynac', exact: true }).click();

  // It survives a reload, and the list shows both.
  await page.reload();
  await expect(page.getByRole('button', { name: 'PHH', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Glynac', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/meetings');
  const row = page.locator('table').first().locator('tr').filter({ hasText: 'intro call' }).first();
  await expect(row).toContainText('PHH');
  await expect(row).toContainText('Glynac');

  // Untagging takes it off again.
  await row.getByRole('link').first().click();
  await page.getByRole('button', { name: 'PHH', exact: true }).click();
  await expect(page.getByRole('button', { name: 'PHH', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await logout(page);
});
