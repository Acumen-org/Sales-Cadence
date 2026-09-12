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
 * End-to-end flows an FO and a manager actually perform, against the seeded demo workspace.
 * Runs serially: later tests build on the campaign created earlier.
 */
test.describe.configure({ mode: 'serial' });

async function loginAs(page: Page, name: 'Admin' | 'Alisa' | 'Leigh' | 'Karson') {
  await page.goto('/login');
  await signInAs(page, name);
  await expect(page).toHaveURL(/\/home/);
}

async function logout(page: Page) {
  await page.getByTitle('Sign out').click();
  await expect(page).toHaveURL(/\/login/);
}

test('everyone signs in with an email and a password, and lands on Home', async ({ page }) => {
  await page.goto('/login');
  // One way in. There are no per-person shortcuts, on any deployment.
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in as/i })).toHaveCount(0);
  // And the session can be kept on a machine one person uses, or expire in a day.
  await expect(page.getByLabel(/Keep me signed in/)).toBeVisible();

  await page.getByLabel('Email').fill('alisa@cadence.local');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(page.getByText(/Email or password is incorrect/i)).toBeVisible();

  await signInAs(page, 'Alisa');
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
  await page.getByLabel('Pod', { exact: true }).selectOption({ label: "Alisa's pod" });
  // Dummy Six is do-not-contact in Twenty: it must be listed as skipped, not enrolled.
  await page.getByRole('button', { name: 'Paste person ids' }).click();
  await page.getByLabel('Twenty person ids').fill('dummy-01\ndummy-02\ndummy-03\ndummy-04\ndummy-06');
  await page.getByRole('button', { name: 'Preview conflicts' }).click();
  await expect(page.getByText(/4 will be enrolled, 1 skipped/)).toBeVisible();
  await expect(page.getByText('Do not contact', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Create campaign and enrol 4/ }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'E2E SaaStr follow-up' })).toBeVisible();
  // The four who were enrolled are on the campaign, and the skipped one is not.
  await expect(page.locator('main')).toContainText('Dummy One');
  await expect(page.locator('main')).not.toContainText('Dummy Six');
  await logout(page);
});

test('the same person cannot be enrolled twice', async ({ page }) => {
  await loginAs(page, 'Alisa');
  await page.goto('/campaigns/new');
  await page.getByLabel('Name', { exact: true }).fill('E2E duplicate check');
  // Dummy One was enrolled by the case above, so a second attempt must refuse.
  await page.getByRole('button', { name: 'Paste person ids' }).click();
  await page.getByLabel('Twenty person ids').fill('dummy-01');
  await page.getByRole('button', { name: 'Preview conflicts' }).click();
  await expect(page.getByText(/0 will be enrolled, 1 skipped/)).toBeVisible();
  await expect(page.getByText('Already in a sequence')).toBeVisible();
  await expect(page.getByRole('button', { name: /Create campaign/ })).toBeDisabled();
  await logout(page);
});

test('task flow: complete an email, log a call with an outcome, skip with a bounce', async ({ page }) => {
  await loginAs(page, 'Alisa');
  // A weekend start rolls to Monday, so the first touches sit under Upcoming rather than Today.
  // Which weekend, though, is the workspace's (US Central), not the runner's: at 00:00 UTC on a
  // Saturday it is still Friday evening in Chicago and the work is under Today. Look for the
  // work rather than guessing the calendar.
  await page.goto('/tasks?tab=today&fo=');
  const dueToday = await page.locator('main').getByRole('link', { name: /^Dummy \w+/ }).count();
  const tab = dueToday ? 'today' : 'upcoming';
  if (!dueToday) await page.goto(`/tasks?tab=${tab}&fo=`);
  // Something is due: the list names at least one person to reach.
  await expect(page.locator('main').getByRole('link', { name: /^Dummy \w+/ }).first()).toBeVisible();

  // Task flow, emails only. The heading is the person; the step is in the line above it.
  await page.goto(`/tasks?tab=${tab}&type=EMAIL&mode=flow`);
  await expect(page.getByText('Task flow', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^\d+ \/ \d+$/).first()).toBeVisible();
  const firstPerson = (await page.locator('#main-content a[href^="/people/"]').first().textContent())!.trim();
  await expect(page.getByLabel('Email subject').first()).toBeVisible(); // template rendered
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  await expect(page.getByRole('status').or(page.getByText(/Step \d+ of \d+/))).toBeVisible();
  // A step is one unit of work: while its LinkedIn module is open the row stays where it is.
  await page.goto(`/tasks?tab=${tab}&type=LINKEDIN`);
  await page.getByRole('link', { name: new RegExp(firstPerson) }).first().click();
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText(/Done\./);

  // Now that both modules are resolved the step has moved to Done, and step 2 is generated.
  await page.goto('/tasks?tab=done');
  await expect(page.getByRole('link', { name: new RegExp(firstPerson) }).first()).toBeVisible();

  // The call is now upcoming (day 3). Log it with an outcome.
  await page.goto('/tasks?tab=upcoming&type=CALL');
  await page.getByRole('link', { name: new RegExp(firstPerson) }).first().click();
  // A call task opens on the call block: the number to ring and the script to work from.
  await expect(page.getByText('Call preparation').first()).toBeVisible();
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
  const secondLink = page.locator('a[href*="task="]').filter({ hasNot: page.getByText(firstPerson, { exact: true }) }).first();
  const secondPerson = (await secondLink.getByTestId('task-person').textContent())!.trim();
  await secondLink.click();
  await page.getByRole('button', { name: 'Skip', exact: true }).first().click();
  await page.getByLabel('Why?', { exact: true }).selectOption('bounced');
  await page.getByRole('button', { name: 'Skip step' }).first().click();
  await expect(page.getByText(/Skipped and removed from the sequence \(bounced\)/)).toBeVisible();

  // Person page reflects it
  await page.goto('/people?q=' + encodeURIComponent(secondPerson.split(' ')[1] ?? secondPerson));
  await page.getByRole('link', { name: secondPerson, exact: true }).click();
  await expect(page.getByText('Bounced').first()).toBeVisible();
  await expect(page.getByText('Email bounced').first()).toBeVisible();
  // And the address it bounced from is now work waiting in Enrichment.
  await page.goto('/enrichment?q=' + encodeURIComponent(secondPerson));
  await expect(page.locator('main')).toContainText('Email needs verification');
  await logout(page);
});

test('answered call finishes the sequence as replied and shows on Home', async ({ page }) => {
  await loginAs(page, 'Alisa');
  // Today or Upcoming, by the workspace's clock rather than the runner's: see the task-flow case.
  await page.goto('/tasks?tab=today&type=EMAIL');
  const tab = (await page.locator('a[href*="task="]').count()) ? 'today' : 'upcoming';
  // Take a fresh person still on Email 1 through both step-1 tasks, then answer the call
  await page.goto(`/tasks?tab=${tab}&type=EMAIL`);
  const link = page.locator('a[href*="task="]').first();
  const person = (await link.getByTestId('task-person').textContent())!.trim();
  await link.click();
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  await expect(page.getByText(/Done\./).first()).toBeVisible();
  await page.goto(`/tasks?tab=${tab}&type=LINKEDIN`);
  await page.getByRole('link', { name: new RegExp(person) }).first().click();
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
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
  // With nothing running, the overview leads with how the last engagement ended.
  await expect(page.getByRole('heading', { name: 'Last campaign' })).toBeVisible();
  await expect(page.locator('main').getByText('Finished (Replied)')).toBeVisible();
  await logout(page);
});

test('a sequence is one editable plan: a free step saves, a step in use is refused', async ({ page }) => {
  await loginAs(page, 'Admin');
  await page.goto('/sequences');
  await page.getByRole('link', { name: /Default outbound/ }).click();
  await page.waitForURL(/\/sequences\/[0-9a-f-]+/);

  // The plan is modules on business days, and a step people are standing on says so.
  await expect(page.getByLabel('Sequence name')).toHaveValue(/Default outbound/);
  await expect(page.getByText(/Business day/).first()).toBeVisible();
  await expect(page.getByText(/Locked\s*\d+ open touch(es)?/).first()).toBeVisible();

  // Editing a step nobody is on saves in place. There is no version to choose.
  const lastSubject = page.getByLabel(/email subject/i).last();
  await lastSubject.fill('e2e: closing subject');
  await page.getByRole('button', { name: 'Save sequence' }).click();
  await expect(page.getByText(/Sequence saved/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/email subject/i).last()).toHaveValue('e2e: closing subject');

  // The locked step's fields cannot be typed into at all, so the refusal is not a surprise
  // that arrives on save.
  const lockedStep = page.locator('section').filter({ hasText: /Locked\s*\d+ open touch(es)?/ }).first();
  await expect(lockedStep.getByLabel(/email subject/i).first()).toBeDisabled();
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
  // The window is a filter with a 28-day default, not a fixed "last 7 days" label.
  await expect(page.getByLabel('From')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByLabel('Through')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator('main')).not.toContainText('Last 7 days');
  await expect(page.locator('main')).not.toContainText('Last 28 days');
  // A longer history is reachable, and the table no longer reports overdue or stalled.
  await page.getByLabel('From').fill('2026-01-01');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByLabel('From')).toHaveValue('2026-01-01');
  await expect(page.locator('table').first()).not.toContainText('Overdue');
  await expect(page.locator('table').first()).not.toContainText('Stalled');
  await page.goto('/reports?tab=pods');
  // Scoped to the table: the pod filter above it lists every pod as an option.
  await expect(page.locator('table').first().getByRole('cell', { name: "Alisa's pod" })).toBeVisible();
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
  // The record's own tabs, with Overview first and selected: point 5 renamed Details and made it
  // the landing tab. Each carries its own live count, so they are matched by prefix.
  const main = page.locator('main');
  await expect(main.getByRole('link', { name: /^Overview/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /^Campaigns & sequences/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /^Activity/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /^CRM emails & notes/ })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Contact details' })).toBeVisible();
  // Pods are administered here (point 16): the pod table is a real table with live counts.
  await page.goto('/settings?tab=users');
  const pods = page.locator('table').nth(1);
  await expect(pods.getByRole('cell', { name: "Alisa's pod" })).toBeVisible();
  const podRow = pods.locator('tr').filter({ hasText: "Alisa's pod" }).first();
  await expect(podRow.locator('td').nth(1)).toHaveText(/^\d+$/); // contacts, from the CRM
  await expect(podRow.locator('td').nth(2)).toHaveText(/^\d+$/); // team members
  await expect(podRow).toContainText('Available');
  await logout(page);
});
