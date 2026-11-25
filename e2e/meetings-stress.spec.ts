import { expect, test, type Page } from '@playwright/test';

/**
 * Meetings, stressed (owner, 23 Nov 2026: "we added a bunch of things ... stress test the meetings
 * section"). Every seat opens Meetings with no page error and no sideways scroll, and every number on
 * the board matches what it says or opens: the month bar's own label, each pod's number of its
 * target, each top booker's meetings, and last month's best.
 */
const SEATS: { email: string; password?: string; card: string | RegExp }[] = [
  { email: 'karson@cadence.local', card: 'Your month' },
  { email: 'andrew@cadence.local', card: 'Your month' },
  { email: 'leigh@cadence.local', card: /^Your pods? this month$/ },
  { email: 'bea@cadence.local', card: 'Team this month' },
  { email: 'admin@cadence.local', password: 'admin12345', card: 'Team this month' },
];

async function signIn(page: Page, email: string, password = 'password123') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/home/);
}
async function sideScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
/** How many meetings a filtered list shows, across its pages. */
async function rowsAt(page: Page, href: string) {
  await page.goto(href);
  await expect(page.getByText(/Showing the meetings that count on the scoreboard/)).toBeVisible();
  return page.locator('table.table-meetings tbody tr').count();
}

for (const seat of SEATS) {
  test(`Meetings board adds up for ${seat.email}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await signIn(page, seat.email, seat.password);
    await page.goto('/meetings');
    const board = page.getByRole('region', { name: 'Meetings scoreboard' });
    await expect(board).toBeVisible();

    // The month: the big number, the bar's label and the next mark agree.
    const card = board.getByRole('region', { name: seat.card });
    const bar = card.getByRole('img', { name: /^\d+ of \d+ booked\./ });
    const [, booked, target] = (await bar.getAttribute('aria-label'))!.match(/^(\d+) of (\d+) booked\./)!.map(Number);
    await expect(card).toContainText(new RegExp(`${booked} of (your )?${target} booked`));
    await expect(card).toContainText(booked >= target ? /Goal reached/ : /\d+ more to reach (Quarter way|Halfway|Final stretch|the goal) at \d+\./);
    await expect(card).toContainText('booked this week');

    // Each pod: the number beside it is what its bar shows of its own target.
    const race = board.getByRole('region', { name: 'Pod race' });
    for (const label of await race.getByRole('img', { name: /: \d+ of \d+ booked$/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!))) {
      const [, x, y] = label.match(/: (\d+) of (\d+) booked$/)!.map(Number);
      expect(y, label).toBeGreaterThan(0);
      await expect(race).toContainText(`${x} of ${y}`);
    }

    // The latest wins fill their part with whole rows, never half of one; stacked on a phone, three at most.
    const wins = board.getByRole('list', { name: 'Meetings booked lately' });
    const fits = async () => wins.evaluate((ul) => {
      const rows = (Array.from(ul.children) as HTMLElement[]).filter((r) => getComputedStyle(r).display !== 'none');
      return { shown: rows.length, cut: rows.filter((r) => r.offsetTop + r.offsetHeight > ul.clientHeight + 1).length };
    });
    if (await wins.count()) {
      await expect.poll(async () => (await fits()).cut).toBe(0);
      expect((await fits()).shown).toBeGreaterThan(0);
    }

    // Narrow and wide, nothing scrolls sideways.
    expect(await sideScroll(page)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await sideScroll(page)).toBeLessThanOrEqual(1);
    if (await wins.count()) await expect.poll(async () => (await fits()).shown).toBeLessThanOrEqual(3);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Every name on the board opens exactly the meetings behind its number, whoever is looking.
    const links = await board.getByRole('region', { name: 'Top bookers' }).getByRole('link', { name: /booked this month\. Open their meetings/ }).evaluateAll((els) => els.map((e) => ({ href: e.getAttribute('href')!, label: e.getAttribute('aria-label')! })));
    const champion = board.getByRole('region', { name: /'s best$/ }).getByRole('link');
    const best = (await champion.count()) ? { href: (await champion.getAttribute('href'))!, label: (await champion.getAttribute('title'))! } : null;
    for (const l of links) expect(await rowsAt(page, l.href), l.label).toBe(Number(l.label.match(/, (\d+) booked this month/)![1]));
    if (best) expect(await rowsAt(page, best.href), best.label).toBe(Number(best.label.match(/Open the (\d+) meetings?/)![1]));

    expect(errors, errors.join('\n')).toEqual([]);
  });
}
