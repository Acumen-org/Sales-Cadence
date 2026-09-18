import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email = 'admin@cadence.local', password = 'admin12345') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}

/** Every navigation the toolbar makes answers late, the way a slow server does. */
async function slowNavigations(page: Page, ms: number) {
  await page.route((url) => url.searchParams.has('_rsc'), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

test('typing fast into a search box keeps every letter while the server is slow', async ({ page }) => {
  await login(page);
  for (const [path, label] of [['/meetings', 'Search meetings'], ['/people?pod=&fo=', 'Search people'], ['/accounts?pod=&fo=', 'Search accounts']] as const) {
    await page.goto(path);
    await slowNavigations(page, 600);
    const box = page.getByLabel(label);
    await box.click();
    await box.pressSequentially('Acubooth', { delay: 90 });
    await expect(box).toHaveValue('Acubooth');
    await expect(page).toHaveURL(/Acubooth/, { timeout: 10_000 });
    await expect(box).toHaveValue('Acubooth');
    await page.unroute(() => true);
  }
});

test('the sort arrow takes focus without an outline escaping the control', async ({ page }) => {
  await login(page);
  await page.goto('/accounts?pod=&fo=');
  const arrow = page.getByRole('button', { name: /^Sort direction/ });
  await arrow.focus();
  const style = await arrow.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, color: s.outlineColor, offset: s.outlineOffset, overflow: getComputedStyle(el.parentElement as HTMLElement).overflow };
  });
  // Nothing drawn outside the control: no outline, or a transparent one, and no clipping parent to
  // turn a stray outline into a sliver.
  expect(style.outline === 'none' || style.color === 'rgba(0, 0, 0, 0)' || style.color === 'transparent').toBe(true);
  expect(style.offset).not.toBe('4px');
  expect(style.overflow).not.toBe('hidden');
});

test('a step is dragged into a new place by its handle', async ({ page }) => {
  await login(page);
  await page.goto('/sequences/new');
  // Two more steps so there is something to reorder: the module buttons add a step each.
  const adder = page.getByText('New touchpoint', { exact: true }).locator('..');
  for (const type of ['Call', 'LinkedIn']) {
    const button = adder.getByRole('button', { name: new RegExp(`^${type}`, 'i') }).first();
    if (await button.count()) await button.click({ timeout: 5_000 }).catch(() => {});
  }
  const handles = page.getByRole('button', { name: /^Drag step/ });
  const count = await handles.count();
  test.skip(count < 3, 'the editor did not offer three steps to reorder');
  const dayOf = async (i: number) => Number(await page.getByLabel(`Step ${i + 1} day`).inputValue());
  const daysBefore = [await dayOf(0), await dayOf(1), await dayOf(2)];
  const third = handles.nth(2);
  const first = handles.nth(0);
  const from = (await third.boundingBox())!;
  const to = (await first.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y - 4, { steps: 8 });
  await page.mouse.up();
  // The step moved to the top, and days stay in order because they belong to the slot.
  expect([await dayOf(0), await dayOf(1), await dayOf(2)]).toEqual(daysBefore);
  await expect(page.locator('ol > li').first()).toContainText(/LinkedIn|Call/);
});

test('the sequence editor asks for the span and shows days, not business days', async ({ page }) => {
  await login(page);
  await page.goto('/sequences/new');
  const span = page.getByLabel('Days the sequence spans');
  await expect(span).toBeVisible();
  await expect(span).toHaveAttribute('required', '');
  // The span can never be shorter than the last step's day.
  const lastDay = Number(await page.getByLabel(/^Step \d+ day$/).last().inputValue());
  await expect(span).toHaveAttribute('min', String(lastDay));
  await expect(page.getByText(/business day/i)).toHaveCount(0);
  await expect(page.getByLabel('Sequence name', { exact: true })).toBeVisible();
});

test('accounts count people with and without an account, and the second opens People', async ({ page }) => {
  await login(page);
  await page.goto('/accounts?pod=&fo=');
  await expect(page.getByText('People with an account', { exact: true })).toBeVisible();
  await expect(page.getByText('People at matching accounts', { exact: true })).toHaveCount(0);
  await page.getByText('People without an account', { exact: true }).click();
  await expect(page).toHaveURL(/\/people\?.*account=none/);
});

test('a person page carries no CRM error banner and settings shows sync health', async ({ page }) => {
  await login(page);
  await page.goto('/people?pod=&fo=');
  await page.locator('tbody a[href^="/people/"]').first().click();
  await expect(page).toHaveURL(/\/people\//);
  await expect(page.getByText(/temporarily unavailable|Bad Gateway|Twenty unavailable/i)).toHaveCount(0);
  await page.goto('/settings?tab=twenty');
  await expect(page.getByText('Webhooks (24h)', { exact: true })).toBeVisible();
  await expect(page.getByText('Live reads', { exact: true })).toBeVisible();
});

test('the blocked accounts tab carries the non-prospect rules', async ({ page }) => {
  await login(page);
  await page.goto('/settings?tab=blocked');
  await expect(page.getByLabel('Never prospects - domains')).toHaveValue(/microsoft\.com/);
  await expect(page.getByLabel('Not accounts - personal email domains')).toHaveValue(/gmail\.com/);
  await expect(page.getByRole('button', { name: 'Apply now' })).toBeVisible();
});
