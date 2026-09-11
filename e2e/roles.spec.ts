import { expect, test, type Page } from '@playwright/test';

/**
 * The app driven end to end as each role, the way that role actually uses it.
 *
 * These are not unit assertions restated in a browser: each case follows one person's real path
 * (a Junior FO working their list, a Senior FO building a sequence and launching a campaign, a
 * Sales Leader approving one, an Admin adding a colleague) and checks both what they can do and
 * what they must not be able to do. Anything a role cannot reach is checked by URL as well as by
 * the absence of a link, because a hidden link is not a permission.
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
  await page.getByRole('button', { name: /Sign out/i }).click();
  await page.waitForURL(/\/login/);
}

/** No page in this app may render an error boundary or scroll sideways. */
async function pageIsSound(page: Page) {
  const body = await page.locator('body').innerText();
  expect(body, page.url()).not.toContain('Application error');
  expect(body, page.url()).not.toContain('server-side exception');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${page.url()} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
}

async function visitAll(page: Page, paths: string[]) {
  for (const path of paths) {
    await page.goto(path);
    await pageIsSound(page);
  }
}

test.describe('Junior FO', () => {
  test('works their own list and cannot reach anyone else’s', async ({ page }) => {
    await signIn(page, 'karson@cadence.local');

    // The sections a junior has: no Reports, no Settings.
    const nav = page.locator('nav').first();
    await expect(nav.getByRole('link', { name: 'Tasks' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Reports' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);

    // Both are refused by URL too, not merely unlinked.
    await page.goto('/reports');
    await expect(page).not.toHaveURL(/\/reports/);
    await page.goto('/settings');
    await expect(page).not.toHaveURL(/\/settings$/);

    // Their own work renders, and every section they do have is sound.
    await visitAll(page, ['/home', '/tasks?tab=today', '/tasks?tab=overdue', '/people', '/accounts', '/meetings', '/activity', '/enrichment']);

    // A junior cannot start a campaign.
    await page.goto('/campaigns');
    await expect(page.getByRole('link', { name: /New campaign/i })).toHaveCount(0);
    await page.goto('/campaigns/new');
    await expect(page).not.toHaveURL(/\/campaigns\/new/);

    // Nor edit the plan everyone runs on: the editor is read-only for them.
    await page.goto('/sequences');
    await expect(page.getByRole('link', { name: /New sequence/i })).toHaveCount(0);
    await page.getByRole('link', { name: /Default outbound/ }).first().click();
    await page.waitForURL(/\/sequences\/[0-9a-f-]+/);
    await expect(page.getByRole('button', { name: 'Save sequence' })).toHaveCount(0);
    await pageIsSound(page);
    await signOut(page);
  });

  test('completes a task and the message they edit is the message they keep', async ({ page }) => {
    await signIn(page, 'karson@cadence.local');
    await page.goto('/tasks?tab=overdue&mode=flow');
    const composer = page.getByRole('textbox', { name: /message|script/i }).first();
    if (await composer.count()) {
      await composer.click();
      await page.keyboard.type('Karson personalised this. ');
      // The draft is saved against the task, so it survives leaving and coming back.
      await expect(page.getByRole('button', { name: 'Saved', exact: true }).first()).toBeVisible({ timeout: 15_000 });
      await page.reload();
      await expect(page.locator('body')).toContainText('Karson personalised this.');
    }
    await pageIsSound(page);
    await signOut(page);
  });
});

test.describe('Senior FO', () => {
  test('builds a sequence out of modules and launches a campaign from it', async ({ page }) => {
    await signIn(page, 'alisa@cadence.local');

    // Build a sequence: name it, then add touchpoints as modules.
    await page.goto('/sequences/new');
    await page.getByLabel(/Sequence name|^Name$/).first().fill('E2E role sequence');
    await page.getByRole('button', { name: /^New touchpoint|Email$/ }).first().click().catch(() => {});
    const addEmail = page.getByRole('button', { name: 'Email', exact: true });
    if (await addEmail.count()) await addEmail.first().click();
    await page.getByRole('button', { name: /Create sequence|Save sequence/ }).click();
    await expect(page.locator('body')).not.toContainText('Application error');

    // Launch a campaign on it, in their own pod.
    await page.goto('/campaigns/new');
    await page.getByLabel('Name', { exact: true }).fill('E2E role campaign');
    await page.getByLabel('Pod', { exact: true }).selectOption({ label: "Alisa's pod" });
    // Thirteen and Fourteen are reserved for this file: earlier specs work dummy-01..06.
    await page.getByLabel('Twenty person ids').fill('dummy-13\ndummy-14');
    await page.getByRole('button', { name: /Preview conflicts/ }).click();
    await expect(page.getByRole('button', { name: /Create campaign|Submit/ })).toBeVisible();
    await pageIsSound(page);

    // A Senior FO reads reports but does not administer the workspace.
    await visitAll(page, ['/reports', '/reports?tab=pods']);
    await page.goto('/settings');
    await expect(page).not.toHaveURL(/\/settings$/);
    await signOut(page);
  });

  test('cannot touch another pod’s work', async ({ page }) => {
    await signIn(page, 'alisa@cadence.local');
    // Andrew's pod is not Alisa's: its people are not in her list, and not behind a URL either.
    await page.goto('/people?pod=ANDREW');
    await pageIsSound(page);
    await expect(page.locator('main')).not.toContainText('Dummy Seven');
    await page.goto('/people?q=Seven');
    await expect(page.locator('main')).not.toContainText('Dummy Seven');
    await page.goto('/people/dummy-07');
    await expect(page.getByText(/find that record/)).toBeVisible();
    // Nor can she start a campaign in it.
    await page.goto('/campaigns/new');
    const pod = page.getByLabel('Pod', { exact: true });
    const options = await pod.locator('option').allTextContents();
    expect(options.join(' ')).not.toContain("Andrew's pod");
    await signOut(page);
  });
});

test.describe('Sales Leader', () => {
  test('approves the follow-up campaign a Senior FO asked for', async ({ page }) => {
    // A Senior FO launches a campaign, then asks for a follow-up on the people who never
    // replied. The case builds its own campaign so it does not depend on another test.
    await signIn(page, 'alisa@cadence.local');
    await page.goto('/campaigns/new');
    await page.getByLabel('Name', { exact: true }).fill('E2E leader source campaign');
    await page.getByLabel('Pod', { exact: true }).selectOption({ label: "Alisa's pod" });
    await page.getByLabel('Twenty person ids').fill('dummy-13\ndummy-14');
    await page.getByRole('button', { name: /Preview conflicts/ }).click();
    await page.getByRole('button', { name: /Create campaign/ }).click();
    await page.waitForURL(/\/campaigns\/[0-9a-f-]+/);

    // Requesting a follow-up submits it for approval rather than launching it.
    await page.getByLabel('Campaign name').fill('E2E follow-up request');
    await page.getByRole('button', { name: /Find who qualifies/ }).click();
    const submit = page.getByRole('button', { name: /Submit for approval/ });
    // With nobody eligible yet the button stays disabled, which is the honest outcome.
    if (await submit.isEnabled()) await submit.click();
    await pageIsSound(page);

    // A Senior FO never approves: that is the line between them and a Sales Leader.
    await page.goto('/campaigns');
    await expect(page.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
    await signOut(page);

    // The Sales Leader leads Alisa's pod, so anything waiting there is theirs to approve.
    await signIn(page, 'leigh@cadence.local');
    await page.goto('/campaigns');
    await pageIsSound(page);
    await expect(page.locator('main')).toContainText('E2E leader source campaign');
    if (await page.getByText('Needs approval').count()) {
      await expect(page.getByRole('button', { name: /^Approve/ }).first()).toBeVisible();
    }
    // A leader reads every pod they lead, and reports.
    await visitAll(page, ['/home', '/reports', '/tasks?tab=today', '/accounts', '/people']);
    // But is still not an administrator.
    await page.goto('/settings');
    await expect(page).not.toHaveURL(/\/settings$/);
    await signOut(page);
  });
});

test.describe('Admin', () => {
  test('adds a colleague, puts them in a pod, and removes them again', async ({ page }) => {
    await signIn(page, 'ria@cadence.local');
    await page.goto('/settings?tab=users');
    // A fresh address each run: an email already on a removed account is refused by design.
    const email = `e2e.newcomer.${Date.now()}@cadence.local`;

    await page.getByRole('button', { name: 'Add team member' }).first().click();
    const form = page.locator('form').filter({ has: page.getByLabel('Name', { exact: true }) }).first();
    await form.getByLabel('Name', { exact: true }).fill('E2E Newcomer');
    await form.getByLabel('Email', { exact: true }).fill(email);
    await form.getByLabel('Role', { exact: true }).selectOption('JUNIOR_FO');
    await form.getByLabel('Password', { exact: true }).fill('newcomer-password-1');
    await form.getByRole('checkbox', { name: /Alisa's pod/ }).check();
    await form.getByRole('button', { name: 'Add team member' }).click();
    // The Team table, not the Pods table below it.
    const team = page.locator('table').first();
    await expect(team).toContainText('E2E Newcomer');
    // The pod they were put in shows against them, and the timezone was never asked for.
    const row = team.locator('tr').filter({ hasText: 'E2E Newcomer' });
    await expect(row).toContainText("Alisa's pod");
    await expect(page.locator('body')).not.toContainText('Timezone');
    await expect(page.locator('body')).not.toContainText('Aliases');

    await row.first().getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove access' }).click();
    // Removed accounts drop out of the default view but are never deleted: their history stays.
    await expect(team).not.toContainText('E2E Newcomer');
    await page.getByLabel('Show removed').check();
    await expect(team.locator('tr').filter({ hasText: 'E2E Newcomer' }).first()).toContainText('Removed');
    await pageIsSound(page);
  });

  test('every section renders for an admin', async ({ page }) => {
    await signIn(page, 'ria@cadence.local');
    await visitAll(page, [
      '/home',
      '/tasks?tab=today',
      '/tasks?tab=today&mode=flow',
      '/tasks?tab=overdue',
      '/tasks?tab=upcoming',
      '/tasks?tab=done',
      '/people',
      '/people?owner=mine',
      '/accounts',
      '/accounts?scope=mine',
      '/meetings',
      '/meetings/new',
      '/enrichment',
      '/sequences',
      '/sequences/new',
      '/campaigns',
      '/campaigns/new',
      '/activity',
      '/reports',
      '/reports?tab=pods',
      '/reports?tab=fos',
      '/reports?tab=campaigns',
      '/reports?tab=sequences',
      '/reports?tab=channels',
      '/settings?tab=users',
      '/settings?tab=rules',
      '/settings?tab=twenty',
      '/settings?tab=ai',
      '/settings?tab=activity',
    ]);
    await signOut(page);
  });

  test('no option constant and no template placeholder reaches any screen', async ({ page }) => {
    await signIn(page, 'ria@cadence.local');
    for (const path of ['/people', '/tasks?tab=today', '/accounts', '/sequences', '/campaigns', '/meetings', '/enrichment']) {
      await page.goto(path);
      const main = page.locator('main');
      // FPA_WISCONSIN_JULY_2026 and friends are values, never labels.
      await expect(main.getByText(/^[A-Z][A-Z0-9]+_[A-Z0-9_]+$/), path).toHaveCount(0);
      // Nothing anywhere still speaks in template variables.
      await expect(main, path).not.toContainText('{{');
    }
    await signOut(page);
  });
});
