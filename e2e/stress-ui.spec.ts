import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email = 'ria@cadence.local') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

test('typing and changing directory filters together preserves both choices', async ({ page }) => {
  await login(page);
  for (const [path, searchName] of [['/people', 'Search people'], ['/accounts', 'Search accounts']]) {
    await page.goto(`${path}?pod=&fo=`);
    await page.getByLabel(searchName, { exact: true }).fill('Dummy');
    // Change the dropdown before the search debounce finishes.
    await page.getByLabel('Filter by pod', { exact: true }).selectOption('ALISA');
    await expect(page).toHaveURL(/q=Dummy/);
    await expect(page.getByLabel('Filter by pod', { exact: true })).toHaveValue('ALISA');
    await expect(page.getByLabel(searchName, { exact: true })).toHaveValue('Dummy');
    await page.reload();
    await expect(page.getByLabel('Filter by pod', { exact: true })).toHaveValue('ALISA');
  }
});

test('table tags expand by keyboard and tables stay inside a narrow viewport', async ({ page }, info) => {
  const font = await page.request.get('/fonts/InterVariable.woff2');
  expect(font.status()).toBe(200);
  expect(font.headers()['content-type']).toContain('font/woff2');
  await login(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/people?pod=&fo=');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('500 13px Inter'))).toBe(true);
  const more = page.getByRole('button', { name: /^Show \d+ more tags$/ }).first();
  await expect(more).toBeVisible();
  await more.focus(); await page.keyboard.press('Enter');
  const less = page.getByRole('button', { name: 'Show fewer tags' }).first();
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: info.outputPath('people-desktop.png') });
  await less.press('Enter');
  await expect(page.getByRole('button', { name: 'Show fewer tags' })).toHaveCount(0);
  for (const path of ['/people?pod=&fo=', '/accounts?pod=&fo=', '/meetings', '/enrichment']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByText('Loading workspace…', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), path).toBe(true);
    await page.screenshot({ path: info.outputPath(`${path.split('?')[0].slice(1)}-mobile.png`) });
  }
});

test('enrichment and meeting filters survive a simultaneous search', async ({ page }) => {
  await login(page);
  await page.goto('/enrichment');
  await page.getByLabel('Search records to enrich').fill('Dummy');
  await page.getByLabel('Missing information', { exact: true }).selectOption('email');
  await page.getByLabel('Missing information', { exact: true }).selectOption('phone');
  await expect(page).toHaveURL(/q=Dummy/);
  await expect(page).toHaveURL(/field=email/);
  await expect(page).toHaveURL(/field=phone/);
  await page.goto('/meetings');
  await page.getByLabel('Search meetings').fill('Dummy');
  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(page).toHaveURL(/who=Dummy/);
  await expect(page.getByRole('button', { name: 'Favourites', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByLabel('Search meetings')).toHaveValue('');
  await expect(page).not.toHaveURL(/who=|fav=/);
});

test('four simultaneous seats can repeatedly read the main sections without browser or server failures', async ({ browser }) => {
  test.setTimeout(180_000);
  await Promise.all(['ria', 'leigh', 'alisa', 'karson'].map(async (name) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
    try {
      await login(page, `${name}@cadence.local`);
      for (let pass = 0; pass < 5; pass++) {
        for (const path of ['/people?pod=&fo=', '/accounts?pod=&fo=', '/tasks', '/meetings', '/enrichment', '/reports', '/activity']) {
          const response = await page.goto(path);
          expect(response?.status(), `${name} ${path}`).toBe(200);
          await expect(page.locator('main')).toBeVisible();
          await expect(page.getByText('Loading workspace…', { exact: true })).toHaveCount(0);
          await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
        }
      }
      expect(errors, name).toEqual([]);
    } finally { await context.close(); }
  }));
});
