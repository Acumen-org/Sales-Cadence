import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

test('FO directory filters include CRM ownership and clearing both reveals other pods', async ({ page }) => {
  await login(page, 'karson@cadence.local');
  for (const path of ['/people', '/accounts']) {
    await page.goto(path);
    const pod = page.getByLabel('Filter by pod');
    const fo = page.getByLabel('Filter by FO');
    await expect(pod).not.toHaveValue('');
    await expect(fo.locator('option:checked')).toHaveText(/Karson/);
    await expect(page.locator('main table tbody tr').first()).toBeVisible();
    await pod.selectOption('');
    await expect(pod).toHaveValue('');
    await fo.selectOption('');
    await expect(fo).toHaveValue('');
    await page.reload();
    await expect(pod).toHaveValue(''); await expect(fo).toHaveValue('');
    await expect(page.getByRole('link', { name: 'Mine', exact: true })).toHaveCount(0);
  }
  await page.goto('/people?pod=&fo=');
  await expect(page.getByRole('link', { name: 'Dummy Seven', exact: true })).toBeVisible();
});

test('enrichment dropdown selections, reset and exported rows agree', async ({ page }) => {
  await login(page, 'alisa@cadence.local');
  await page.goto('/enrichment');
  const search = page.getByLabel('Search records to enrich');
  await search.fill('Dummy');
  await expect(page).toHaveURL(/q=Dummy/);
  await page.getByLabel('Missing information', { exact: true }).selectOption('email');
  await expect(page).toHaveURL(/field=email/);
  await page.getByLabel('Missing information', { exact: true }).selectOption('phone');
  await expect(page).toHaveURL(/field=phone/);
  const href = await page.getByRole('link', { name: 'Export to enrich' }).getAttribute('href');
  expect(href).toContain('q=Dummy'); expect(href).toContain('field=email'); expect(href).toContain('field=phone');
  const csv = await (await page.request.get(href!)).text();
  expect(csv).toContain('recordId');
  expect(csv).toContain('Dummy');
  await page.getByRole('link', { name: 'Reset', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page).not.toHaveURL(/field=|q=/);
});

test('Pod Manager and Biz Ops seats work with their distinct write permissions', async ({ page, browser }) => {
  await login(page, 'ria@cadence.local');
  for (const [name, email, role] of [['Audit Ops', 'audit-ops@cadence.local', 'BIZ_OPS'], ['Audit Manager', 'audit-manager@cadence.local', 'POD_MANAGER']]) {
    await page.goto('/settings?tab=users');
    await page.getByRole('button', { name: 'Add team member', exact: true }).click();
    const form = page.locator('form').filter({ has: page.locator('input[name="email"]') });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Email', { exact: true }).fill(email);
    await form.getByLabel('Role', { exact: true }).selectOption(role);
    await form.getByLabel('Password', { exact: true }).fill('password123');
    if (role === 'POD_MANAGER') await form.getByRole('checkbox', { name: /Alisa/ }).check();
    await form.getByRole('button', { name: 'Add team member', exact: true }).click();
    await expect(page.getByRole('cell', { name: new RegExp(name) })).toBeVisible();
  }
  await page.goto('/meetings/new');
  await page.getByLabel('Title', { exact: true }).fill('Audit shared meeting');
  await page.getByLabel('Recording or meeting link').fill('https://example.com/audit.mp4');
  await page.getByRole('button', { name: 'Add meeting', exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+$/);
  const meetingUrl = page.url();
  for (const role of ['ops', 'manager']) {
    const context = await browser.newContext(); const seat = await context.newPage();
    await login(seat, `audit-${role}@cadence.local`);
    await seat.goto('/meetings');
    await expect(seat.getByRole('link', { name: 'Audit shared meeting', exact: true })).toBeVisible();
    if (role === 'ops') {
      await expect(seat.getByRole('link', { name: 'Add meeting', exact: true })).toHaveCount(0);
      await seat.goto('/meetings/new'); await expect(seat).toHaveURL(/\/meetings$/);
      await seat.goto(meetingUrl);
      await seat.getByRole('button', { name: 'Add to favourites', exact: true }).click();
      await expect(seat.getByRole('button', { name: 'Favourite', exact: true })).toBeVisible();
      await seat.goto('/meetings?fav=1');
      await expect(seat.getByRole('link', { name: 'Audit shared meeting', exact: true })).toBeVisible();
      await seat.goto('/reports'); await expect(seat).toHaveURL(/\/reports$/);
    } else {
      await expect(seat.getByRole('link', { name: 'Add meeting', exact: true })).toBeVisible();
      await seat.goto('/tasks');
      await expect(seat.getByLabel('Filter by pod')).not.toHaveValue('');
      await expect(seat.getByLabel('Filter by FO')).toHaveValue('');
      await seat.goto('/campaigns/new'); await expect(seat).toHaveURL(/\/campaigns\/new$/);
    }
    await seat.goto('/settings'); await expect(seat).not.toHaveURL(/\/settings$/);
    await context.close();
  }
});
