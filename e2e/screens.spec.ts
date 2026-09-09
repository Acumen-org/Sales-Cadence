import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Not an assertion suite: captures the main screens so the design can be reviewed.
 * `pnpm screens` writes PNGs to .screens/.
 */
const OUT = path.join(process.cwd(), '.screens');
test.use({ viewport: { width: 1600, height: 1000 } });

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });
}

test('capture screens', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });

  await page.goto('/login');
  await shot(page, '01-login');

  await page.getByRole('button', { name: /^Alisa/ }).click();
  await page.waitForURL(/\/home/);
  await shot(page, '02-home');

  await page.goto('/tasks?tab=today');
  await shot(page, '03-tasks-list');

  await page.goto('/tasks?tab=today&mode=flow');
  await shot(page, '04-tasks-flow');

  // Point 3 is that each channel shows something relevant to that channel, so each one is
  // captured deliberately rather than whichever happens to be first in the queue. A call is on
  // day 3 of the plan and is only generated once day 1 is worked, so one person is taken there
  // first - which is also how an FO reaches it.
  await page.goto('/tasks?tab=today&type=LINKEDIN');
  await shot(page, '04c-task-linkedin');

  for (const type of ['EMAIL', 'LINKEDIN']) {
    await page.goto(`/tasks?tab=today&type=${type}`);
    const done = page.getByRole('button', { name: 'Done', exact: true }).first();
    if (await done.isVisible().catch(() => false)) {
      await done.click();
      await page.waitForLoadState('networkidle').catch(() => {});
    }
  }
  await page.goto('/tasks?tab=upcoming&type=CALL');
  await shot(page, '04b-task-call');
  await page.goto('/tasks?tab=today&type=EMAIL');

  const call = page.getByRole('button', { name: 'Log call' }).first();
  if (await call.isVisible().catch(() => false)) {
    await call.click();
    await shot(page, '05-call-outcome');
    await page.keyboard.press('Escape');
  }

  // The overflow panel: ending a sequence and jumping to a step, in one place.
  await page.goto('/tasks?tab=today');
  const more = page.getByRole('button', { name: 'More' }).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await shot(page, '05b-task-more');
  }

  await page.goto('/people');
  await shot(page, '06-people');

  const first = page.getByRole('link', { name: /Dummy/ }).first();
  if (await first.isVisible().catch(() => false)) {
    await first.click();
    await page.waitForURL(/\/people\//);
    await shot(page, '07-person');
  }
  // The Twenty record itself, grouped the way Twenty groups it.
  await page.goto('/people/dummy-01?tab=overview');
  await shot(page, '07b-person-overview');
  await page.goto('/people/dummy-01?tab=sequences');
  await shot(page, '07c-person-history');
  await page.goto('/people/dummy-01?tab=crm');
  await shot(page, '07d-person-crm');

  await page.goto('/enrichment');
  await shot(page, '07e-enrichment');

  await page.goto('/sequences');
  await shot(page, '08-sequences');
  await page.getByRole('link', { name: /Default outbound/ }).first().click();
  await page.waitForURL(/\/sequences\//);
  await shot(page, '09-sequence-detail');
  await page.goto('/sequences/new');
  await shot(page, '09b-sequence-new');

  await page.goto('/campaigns');
  await shot(page, '10-campaigns');
  const camp = page.getByRole('link', { name: /Dummy campaign/ }).first();
  if (await camp.isVisible().catch(() => false)) {
    await camp.click();
    await page.waitForURL(/\/campaigns\//);
    await shot(page, '11-campaign-detail');
  }

  // Admin-only screens
  await page.getByTitle('Sign out').click();
  await page.waitForURL(/\/login/);
  await page.getByRole('button', { name: /^Admin/ }).click();
  await page.waitForURL(/\/home/);
  await page.goto('/reports');
  await shot(page, '12-reports');
  await page.goto('/settings?tab=users');
  await shot(page, '13-settings-users');
  await page.goto('/settings?tab=twenty');
  await shot(page, '14-settings-twenty');

  // Global search is available throughout the workspace.
  await page.goto('/tasks');
  await page.getByTitle('Search (Ctrl+K)').click();
  await page.getByPlaceholder('Search people, campaigns and sequences').fill('Dummy');
  await page.waitForTimeout(600);
  await shot(page, '15-search');
  await page.keyboard.press('Escape');

  // Sections added later: meetings, accounts and the activity feed.
  await page.goto('/meetings');
  await shot(page, '16-meetings');
  const meeting = page.getByRole('link', { name: /intro call/ }).first();
  if (await meeting.isVisible().catch(() => false)) {
    await meeting.click();
    await page.waitForURL(/\/meetings\//);
    await page.waitForTimeout(400);
    await shot(page, '17-meeting-detail');
  }
  await page.goto('/meetings/new');
  await shot(page, '18-meeting-new');

  await page.goto('/accounts');
  await shot(page, '19-accounts');
  const account = page.getByRole('link', { name: 'Dummy Company A' }).first();
  if (await account.isVisible().catch(() => false)) {
    await account.click();
    await page.waitForURL(/\/accounts\//);
    await shot(page, '20-account-overview');
    const url = page.url().replace(/\?.*$/, '');
    await page.goto(`${url}?tab=relationships`);
    await shot(page, '21-account-people-by-title');
    await page.goto(`${page.url().split('?')[0]}?tab=people`);
    await shot(page, '21b-account-people');
    await page.goto(`${url}?tab=timeline`);
    await shot(page, '22-account-timeline');
  }

  await page.goto('/activity');
  await shot(page, '23-activity');
  await page.goto('/settings?tab=rules');
  await shot(page, '25-settings-rules');
  await page.goto('/settings?tab=ai');
  await shot(page, '26-settings-ai');
  await page.goto('/campaigns/new');
  await shot(page, '27-campaign-new');

  // What a Junior FO sees: fewer sections, no administration.
  await page.getByRole('button', { name: /Sign out/i }).click();
  await page.waitForURL(/\/login/);
  await page.getByRole('button', { name: /^Karson/ }).click();
  await page.waitForURL(/\/home/);
  await shot(page, '28-junior-home');
  await page.goto('/tasks?tab=today');
  await shot(page, '29-junior-tasks');

  // And the same workspace on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks?tab=today');
  await shot(page, '30-mobile-tasks');
  await page.goto('/home');
  await shot(page, '31-mobile-home');
});
