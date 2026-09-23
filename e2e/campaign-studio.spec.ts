import {beginStudio} from './studio-helper';
import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({ datasourceUrl: 'postgresql://postgres:postgres@localhost:5435/cadence' });
test.afterAll(async () => db.$disconnect());
async function login(page: Page, email = 'admin@cadence.local') {
  await page.goto('/login'); await page.getByLabel('Email', { exact:true }).fill(email);
  await page.getByLabel('Password', { exact:true }).fill(email === 'admin@cadence.local' ? 'admin12345' : 'password123');
  await page.getByRole('button', { name:/^Sign in/ }).click(); await page.waitForURL(/home/);
}
test('builds contact-specific outreach, publishes a full calendar, and edits the upcoming plan',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await login(page);await beginStudio(page,'StudioPilot');
  await page.getByRole('button',{name:'Add outreach group',exact:true}).click();
  await page.getByLabel('Search people to add').fill('StudioPilot');
  await page.getByLabel('Select StudioPilot 2',{exact:true}).check();
  await page.getByRole('button',{name:'Create outreach group (1)'}).click();
  await page.getByLabel('Outreach group name').fill('Personal introduction');
  await page.getByLabel('Step 1 email subject').fill('A personal introduction');
  await page.getByRole('button',{name:'Next: Schedule'}).click();
  await expect(page.getByRole('heading',{name:'Your outreach calendar'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Publish campaign'})).toBeEnabled();
  await page.getByRole('button',{name:/Default · Batch/}).first().click();
  await expect(page.getByRole('dialog')).toContainText('Monday, Jan 4, 2027');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Publish campaign'}).click();
  await page.waitForURL(/\/campaigns\/[a-f0-9-]+$/);
  await expect(page.getByRole('heading',{name:'StudioPilot',exact:true})).toBeVisible();
  const campaignId=page.url().split('/').at(-1)!;
  const c=await db.campaign.findUniqueOrThrow({where:{id:campaignId}});expect(c.status).toBe('SCHEDULED');expect(c.publishedPlan).not.toBeNull();
  await page.getByRole('link',{name:'Edit campaign',exact:true}).click();
  await page.getByLabel('Campaign name',{exact:true}).fill('StudioPilot revised');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.reload();await expect(page.getByLabel('Campaign name',{exact:true})).toHaveValue('StudioPilot revised');
  expect((await db.campaign.findUniqueOrThrow({where:{id:campaignId}})).status).toBe('DRAFT');
  expect(errors).toEqual([]);
});
test('an edited outreach that cannot take everyone says why in Outreach and offers verified fixes',async({page})=>{
  await login(page);await beginStudio(page,'StudioGap');await page.getByLabel('Gap before step 2').fill('2');
  await expect(page.getByText('Adjust this plan',{exact:true})).toBeVisible();
  await expect(page.getByText('Alisa Senior: no arrangement of this outreach covers every working day.',{exact:true}).first()).toBeVisible();
  await expect(page.getByRole('button',{name:'Next: Schedule'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Let the studio set the outreach',exact:true}).first()).toBeVisible();
  await page.getByText('Wait 1 day before step 2',{exact:true}).locator('xpath=../..').getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.getByRole('region',{name:'Plan'})).toContainText('4 people planned');
  await page.getByRole('button',{name:'Next: Schedule'}).click();
  await expect(page.getByRole('heading',{name:'Your outreach calendar'})).toBeVisible();
  await page.getByRole('button',{name:'Dates & limits'}).click();await page.getByLabel('Adjust end date').fill('2027-01-15');await page.getByRole('button',{name:'Update calendar'}).click();
  await expect(page.getByRole('dialog')).toContainText('Adjust this plan');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your outreach calendar'})).toBeVisible();
});
test('retired sequence URLs lead to campaigns and the studio fits a phone',async({page})=>{
  await login(page);await page.goto('/sequences');await expect(page).toHaveURL(/\/campaigns$/);
  await expect(page.getByRole('link',{name:'Sequences',exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});await page.goto('/campaigns/new');
  await expect(page.getByRole('heading',{name:'Build your next conversation'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
  await beginStudio(page,'StudioMobile');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
});

test('gates setup and leaves numeric inputs empty while editing',async({page})=>{
 await login(page);await page.goto('/campaigns/new');
 // Next never waits in silence: it names everything still needed, once.
 await page.getByRole('button',{name:'Next: Outreach'}).click();
 await expect(page.locator('main').getByRole('alert')).toContainText('Still needed: a campaign name, a product, an FO and people.');
 const nav=page.getByRole('navigation',{name:'Campaign setup'});await expect(nav.getByRole('button').nth(2)).toBeDisabled();
 const rate=page.getByLabel('Default new people per day');await rate.fill('');await expect(rate).toHaveValue('');await rate.pressSequentially('25');await expect(rate).toHaveValue('25');
 await page.getByRole('checkbox',{name:'Alisa Senior',exact:true}).check();const own=page.getByLabel('Alisa Senior new people per day');await own.fill('');await expect(own).toHaveValue('');await own.pressSequentially('12');await expect(own).toHaveValue('12');
 await expect(page.locator('option').filter({hasText:'Finished a sequence'})).toHaveCount(0);
});

test('adapts the starter and keeps custom groups exclusive with sidebar editing',async({page})=>{
 await login(page);await beginStudio(page,'StudioGroups');await expect(page.getByRole('button',{name:/^Drag step/})).toHaveCount(2);
 // A third step still keeps all four people, at two a day, so it is offered.
 const addEmail=page.getByRole('button',{name:'Email',exact:true}).last();await expect(addEmail).toBeEnabled();
 await addEmail.click();await expect(page.getByRole('button',{name:/^Drag step/})).toHaveCount(3);await expect(page.getByRole('region',{name:'Plan'})).toContainText('4 people planned');
 await page.getByRole('button',{name:'Remove step 3'}).click();await expect(page.getByRole('button',{name:/^Drag step/})).toHaveCount(2);
 const sidebar=page.getByRole('complementary',{name:'Outreach groups'});
 await sidebar.getByRole('button',{name:'Add outreach group',exact:true}).click();await page.getByLabel('Select StudioGroups 1',{exact:true}).check();await page.getByRole('button',{name:'Create outreach group (1)'}).click();
 const name=page.getByLabel('Outreach group name');await name.fill('');await expect(name).toHaveValue('');await expect(page.getByRole('button',{name:'Next: Schedule'})).toBeDisabled();await name.fill('Clients');
 await sidebar.getByRole('button',{name:'Add outreach group',exact:true}).click();await expect(page.getByLabel('Select StudioGroups 1',{exact:true})).toBeDisabled();await page.getByLabel('Select everyone shown',{exact:true}).check();await page.getByRole('button',{name:'Create outreach group (3)'}).click();await page.getByLabel('Outreach group name').fill('Other contacts');
 await expect(sidebar.getByRole('button',{name:'Default',exact:true}).locator('..').locator('..')).toContainText('0 people');
 await expect(sidebar.getByRole('button',{name:'Add outreach group',exact:true})).toBeDisabled();
 page.once('dialog',dialog=>dialog.accept());await sidebar.getByRole('button',{name:'Delete Other contacts',exact:true}).click();
 await expect(sidebar.getByRole('button',{name:'Default',exact:true}).locator('..').locator('..')).toContainText('3 people');
 await expect(sidebar.getByRole('button',{name:'Clients',exact:true})).toBeVisible();
});

test('People campaign controls are bulk-only and mixed selections add only available people',async({page})=>{
 await login(page);await beginStudio(page,'StudioBulk');await page.getByRole('button',{name:'Next: Schedule'}).click();await page.getByRole('button',{name:'Publish campaign'}).click();await page.waitForURL(/\/campaigns\/[a-f0-9-]+$/);const id=page.url().split('/').at(-1)!;
 await db.personCache.create({data:{id:'StudioBulk-free',firstName:'StudioBulk',lastName:'Free',sortName:'studiobulk free',podOwner:'ALISA',email:'bulk-free@example.test'}});
 await page.goto('/people?pod=&fo=&q=StudioBulk');await expect(page.locator('tbody').getByRole('button',{name:/^Remove/})).toHaveCount(0);
 await page.getByLabel('Select StudioBulk 1',{exact:true}).check();await expect(page.getByRole('button',{name:'Add to campaign',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Remove from campaign',exact:true})).toBeEnabled();
 await page.getByLabel('Select StudioBulk Free',{exact:true}).check();await page.getByRole('button',{name:'Add to campaign',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Add 1 person to a campaign');await page.getByRole('button',{name:'Close',exact:true}).last().click();
 await page.getByLabel('Select StudioBulk 1',{exact:true}).uncheck();await expect(page.getByRole('button',{name:'Remove from campaign',exact:true})).toBeDisabled();
 await page.getByLabel('Select StudioBulk Free',{exact:true}).uncheck();await page.getByLabel('Select StudioBulk 1',{exact:true}).check();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Remove from campaign',exact:true}).click();await expect(page.getByText(/Review and publish the updated campaign calendar/)).toBeVisible();
 const c=await db.campaign.findUniqueOrThrow({where:{id}});expect(c.status).toBe('DRAFT');expect(c.personIds).not.toContain('StudioBulk-0');expect(c.publishedPlan).toBeNull();
});

test('meeting tables fit desktop and phone without a horizontal scroll area',async({page})=>{
 await login(page);for(const width of [1440,1024,390]){await page.setViewportSize({width,height:900});await page.goto('/meetings');expect(await page.locator('table').evaluateAll(tables=>tables.every(table=>table.scrollWidth<=table.clientWidth+2 && table.parentElement!.scrollWidth<=table.parentElement!.clientWidth+2))).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);}
});

test('admin can permanently erase a draft through its confirmation dialog',async({page})=>{
 await login(page);await beginStudio(page,'StudioErase');await expect(page.getByText('Draft saved',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save draft',exact:true})).toHaveCount(0);const id=page.url().split('/').at(-2)!;
 await page.goto(`/campaigns/${id}`);await page.getByRole('button',{name:'Delete campaign',exact:true}).click();await expect(page.getByRole('button',{name:'Permanently delete',exact:true})).toBeDisabled();await page.getByLabel('Confirm campaign name').fill('StudioErase');await page.getByRole('button',{name:'Permanently delete',exact:true}).click();await page.waitForURL(/\/campaigns$/);expect(await db.campaign.findUnique({where:{id}})).toBeNull();expect(await db.personCache.count({where:{id:{startsWith:'StudioErase-'}}})).toBe(4);
});

test('unreachable contacts are skipped in the picker and left out of the plan with their reason',async({page})=>{
 await login(page);await beginStudio(page,'AudienceReview');await page.getByRole('button',{name:'Back',exact:true}).click();
 await db.personCache.createMany({data:[{id:'AudienceReview-dnd',firstName:'AudienceReview',lastName:'DoNotContact',sortName:'audiencereview donotcontact',podOwner:'ALISA',dnd:true},{id:'AudienceReview-optout',firstName:'AudienceReview',lastName:'OptedOut',sortName:'audiencereview optedout',podOwner:'ALISA',optedOut:true}]});
 await page.getByLabel('Search people to add').fill('AudienceReview');await expect(page.getByText('6 matching')).toBeVisible();await expect(page.getByRole('button',{name:'Select all matching',exact:true})).toBeEnabled();
 await expect(page.getByLabel('Select AudienceReview DoNotContact',{exact:true})).toBeDisabled();await expect(page.getByLabel('Select AudienceReview OptedOut',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Select all matching',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'2 unavailable skipped'})).toBeVisible();
 // A CRM flag set after selection does not stop the campaign: that person is left out, by name.
 await db.personCache.update({where:{id:'AudienceReview-0'},data:{dnd:true}});
 await page.getByRole('button',{name:'Next: Outreach',exact:true}).click();await expect(page.getByRole('heading',{name:'Outreach groups',exact:true})).toBeVisible();
 await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
 const plan=page.getByRole('region',{name:'Plan'});await expect(plan).toContainText('3 of 4 planned');
 await plan.getByRole('button',{name:'1 left out'}).click();await expect(plan).toContainText('Do not contact');await expect(plan).toContainText('AudienceReview 1');
 await page.getByRole('button',{name:'Next: Schedule'}).click();await expect(page.getByRole('button',{name:'Publish campaign'})).toBeEnabled();
});

test('the studio saves its own draft as it is filled in',async({page})=>{
 await login(page);await page.goto('/campaigns/new');await page.getByLabel('Campaign name',{exact:true}).fill('Saves itself');
 await expect(page.getByText('Draft saved',{exact:true})).toBeVisible();await expect(page).toHaveURL(/\/campaigns\/[a-f0-9-]+\/edit$/);
 await page.getByLabel('Default new people per day').fill('');await page.getByRole('button',{name:'PHH',exact:true}).click();await expect(page.getByText('Draft saved',{exact:true})).toBeVisible();
 await page.reload();await expect(page.getByLabel('Campaign name',{exact:true})).toHaveValue('Saves itself');await expect(page.getByLabel('Default new people per day')).toHaveValue('');await expect(page.getByRole('button',{name:'PHH',exact:true})).toHaveAttribute('aria-pressed','true');
 const id=page.url().split('/').at(-2)!;const c=await db.campaign.findUniqueOrThrow({where:{id}});expect(c.status).toBe('DRAFT');expect(c.name).toBe('Saves itself');
});
