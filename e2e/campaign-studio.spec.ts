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
  // Every FO at once by default: each day lists its FOs and how many people they reach; one opens their own calendar.
  await expect(page.getByLabel('Calendar FO')).toHaveValue('all');
  await expect(page.getByRole('button',{name:/^Default · Step 1 of/})).toHaveCount(0);
  await page.locator('[data-day="2027-01-04"]').getByRole('button').first().click();
  await expect(page.getByLabel('Calendar FO')).not.toHaveValue('all');
  await page.getByRole('button',{name:/^Default · Step 1 of/}).first().click();
  await expect(page.getByRole('dialog')).toContainText('Monday, Jan 4, 2027');
  await page.keyboard.press('Escape');
  // A real week, Monday to Sunday; closing a batch leaves every other batch as it was.
  for(const d of ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])await expect(page.getByText(d,{exact:true}).first()).toBeVisible();
  // Hovering a batch outlines its other steps; moving away, or closing its details, leaves nothing marked.
  const marked=page.locator('[data-day] button.ring-2');await page.mouse.move(0,0);await expect(marked).toHaveCount(0);
  await page.getByRole('button',{name:/^Default · Step 1 of/}).first().hover();await expect(marked).not.toHaveCount(0);
  await page.mouse.move(0,0);await expect(marked).toHaveCount(0);
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
  const fix=page.getByRole('region',{name:'Adjust this plan'});
  await expect(fix.getByRole('heading',{name:'Alisa Senior would have working days with nothing to send',exact:true})).toBeVisible();
  await expect(fix).toContainText('The waits between steps leave gaps. Every FO needs something to send each working day.');
  await expect(page.getByRole('button',{name:'Next: Schedule'})).toBeDisabled();
  // Typing while it is re-checked keeps the panel where it is instead of pulling it out from under the cursor.
  await page.getByLabel('Step 1 email subject').fill('Still here');expect(await fix.count()).toBe(1);await expect(fix.getByRole('button',{name:'Set it for me'})).toBeEnabled();
  // The studio's own outreach is the recommended fix, in the panel and beside Next; it can be taken back.
  await expect(page.locator('footer')).toContainText('Fix the plan above to continue.');await expect(page.locator('footer').getByRole('button',{name:'See how to fix'})).toBeVisible();
  await expect(fix).toContainText('Let the studio set the outreach');
  await fix.getByRole('button',{name:'Set it for me',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'The studio set the outreach.'})).toBeVisible();
  await expect(page.getByRole('region',{name:'Plan'})).toContainText('4 people planned');await expect(fix).toHaveCount(0);
  await expect(page.getByRole('complementary',{name:'Outreach groups'})).not.toContainText('Let the studio set the outreach');
  await page.getByRole('status').filter({hasText:'The studio set the outreach.'}).getByRole('button',{name:'Undo this change'}).click();
  await expect(fix).toContainText('would have working days with nothing to send');await expect(page.getByLabel('Gap before step 2')).toHaveValue('2');
  await fix.getByText('Send step 2 one day after step 1, not two',{exact:true}).locator('xpath=../..').getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.getByRole('region',{name:'Plan'})).toContainText('4 people planned');
  await expect(page.getByRole('status').filter({hasText:'Changed: Send step 2 one day after step 1, not two.'})).toBeVisible();
  await page.getByRole('button',{name:'Next: Schedule'}).click();
  await expect(page.getByRole('heading',{name:'Your outreach calendar'})).toBeVisible();
  await page.getByRole('button',{name:'Dates and limits'}).click();await page.getByLabel('Adjust end date').fill('2027-01-15');await page.getByRole('button',{name:'Update calendar'}).click();
  const dialog=page.getByRole('dialog');await expect(dialog.getByRole('region',{name:'Adjust this plan'})).toBeVisible();
  // Nothing changed since the plan that does not fit: Update waits for a change.
  await expect(dialog.getByRole('button',{name:'Update calendar'})).toBeDisabled();
  // A fix applied here can be taken back on Schedule too.
  await dialog.getByRole('button',{name:'Set it for me',exact:true}).click();await expect(dialog).toHaveCount(0);
  const undone=page.getByRole('status').filter({hasText:'Dates and limits changed.'});await expect(undone).toBeVisible();await expect(page.getByText(/Jan 15 · \d+ working days/)).toBeVisible();
  await undone.getByRole('button',{name:'Undo this change'}).click();await expect(undone).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Your outreach calendar'})).toBeVisible();await expect(page.getByText(/Jan 15 · \d+ working days/)).toHaveCount(0);
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
 await page.getByLabel('Select StudioBulk Free',{exact:true}).uncheck();await page.getByLabel('Select StudioBulk 1',{exact:true}).check();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Remove from campaign',exact:true}).click();await expect(page.getByText('1 person removed from StudioBulk, and its calendar was updated.')).toBeVisible();
 // A scheduled campaign is planned again and stays scheduled, without the person taken out.
 const c=await db.campaign.findUniqueOrThrow({where:{id}});expect(c.status).toBe('SCHEDULED');expect(c.personIds).not.toContain('StudioBulk-0');
 const plan=c.publishedPlan as {batches:{personIds:string[]}[]};expect(plan.batches.flatMap(b=>b.personIds).sort()).toEqual(['StudioBulk-1','StudioBulk-2','StudioBulk-3']);
});

test('meeting tables fit desktop and phone without a horizontal scroll area',async({page})=>{
 await login(page);for(const width of [1440,1024,390]){await page.setViewportSize({width,height:900});await page.goto('/meetings');expect(await page.locator('table').evaluateAll(tables=>tables.every(table=>table.scrollWidth<=table.clientWidth+2 && table.parentElement!.scrollWidth<=table.parentElement!.clientWidth+2))).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);}
});

test('admin can permanently erase a draft through its confirmation dialog',async({page})=>{
 await login(page);await beginStudio(page,'StudioErase');await expect(page.getByText('Draft saved',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save draft',exact:true})).toHaveCount(0);const id=page.url().split('/').at(-2)!;
 await page.goto(`/campaigns/${id}`);await page.getByRole('button',{name:'Delete campaign',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Delete StudioErase?');await expect(page.getByLabel('Confirm campaign name')).toHaveCount(0);await page.getByRole('button',{name:'Delete',exact:true}).click();await page.waitForURL(/\/campaigns$/);expect(await db.campaign.findUnique({where:{id}})).toBeNull();expect(await db.personCache.count({where:{id:{startsWith:'StudioErase-'}}})).toBe(4);
});

test('unreachable contacts are skipped in the picker and left out of the plan with their reason',async({page})=>{
 await login(page);await beginStudio(page,'AudienceReview');await page.getByRole('button',{name:'Back',exact:true}).click();
 await db.personCache.createMany({data:[{id:'AudienceReview-dnd',firstName:'AudienceReview',lastName:'DoNotContact',sortName:'audiencereview donotcontact',podOwner:'ALISA',dnd:true},{id:'AudienceReview-optout',firstName:'AudienceReview',lastName:'OptedOut',sortName:'audiencereview optedout',podOwner:'ALISA',optedOut:true}]});
 await page.getByLabel('Search people to add').fill('AudienceReview');await expect(page.getByText('6 matching')).toBeVisible();await expect(page.getByRole('button',{name:'Select all matching',exact:true})).toBeEnabled();
 await expect(page.getByLabel('Select AudienceReview DoNotContact',{exact:true})).toBeDisabled();await expect(page.getByLabel('Select AudienceReview OptedOut',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Select all matching',exact:true}).click();await expect(page.getByRole('status').filter({hasText:"2 people can't join this campaign and weren't added"})).toBeVisible();
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

test('filter dropdowns stay the same element while the list reloads, so one that is open does not close',async({page})=>{
 await login(page);await page.goto('/campaigns/new');
 // Before: each re-render made a new <select>, and an open one closed as soon as results arrived.
 const fo=await page.getByLabel('Filter by FO',{exact:true}).elementHandle();
 await page.getByLabel('Search people to add').fill('Dummy');await page.waitForTimeout(900);
 expect(await fo!.evaluate(el=>el.isConnected)).toBe(true);
 await page.getByRole('button',{name:'MIP',exact:true}).click();await expect(page.getByRole('button',{name:'MIP',exact:true})).toHaveAttribute('aria-pressed','true');
 expect(await fo!.evaluate(el=>el.isConnected)).toBe(true);
});

test('a pod leader deletes a draft; an FO of the pod cannot',async({page,browser})=>{
 await login(page,'leigh@cadence.local');await beginStudio(page,'LeaderErase');await expect(page.getByText('Draft saved',{exact:true})).toBeVisible();const id=page.url().split('/').at(-2)!;
 // The Upcoming list shows the whole row, its last column included.
 await page.setViewportSize({width:1280,height:900});await page.goto('/campaigns?tab=upcoming');
 const row=page.locator('tr',{hasText:'LeaderErase'});await expect(row).toBeVisible();
 expect(await page.locator('table').first().evaluate(t=>t.scrollWidth<=t.parentElement!.clientWidth+2)).toBe(true);
 const box=await row.boundingBox(),table=await page.locator('table').first().boundingBox();expect(box!.x+box!.width).toBeLessThanOrEqual(table!.x+table!.width+1);
 const fo=await browser.newPage();await login(fo,'karson@cadence.local');await fo.goto(`/campaigns/${id}`);await expect(fo.getByRole('heading',{name:'LeaderErase',exact:true})).toBeVisible();await expect(fo.getByRole('button',{name:'Delete campaign',exact:true})).toHaveCount(0);await fo.close();
 await page.goto(`/campaigns/${id}`);await page.getByRole('button',{name:'Delete campaign',exact:true}).click();await page.getByRole('button',{name:'Delete',exact:true}).click();await page.waitForURL(/\/campaigns$/);
 expect(await db.campaign.findUnique({where:{id}})).toBeNull();
});

test('a campaign lists its people 50 to a page, before and after it starts',async({page})=>{
 await login(page);await beginStudio(page,'PagedPeople');await expect(page.getByText('Draft saved',{exact:true})).toBeVisible();const id=page.url().split('/').at(-2)!;
 const extra=Array.from({length:56},(_,i)=>({id:`PagedPeople-x${String(i).padStart(2,'0')}`,firstName:'PagedPeople',lastName:`X${String(i).padStart(2,'0')}`,sortName:`pagedpeople x${String(i).padStart(2,'0')}`,podOwner:'ALISA',email:`paged${i}@outreach-test.example`}));
 await db.personCache.createMany({data:extra});
 const c=await db.campaign.findUniqueOrThrow({where:{id}});const ids=[...c.personIds,...extra.map(p=>p.id)];const d=c.plannerDraft as {personIds:string[];request?:{personIds:string[]}};
 await db.campaign.update({where:{id},data:{personIds:ids,plannerDraft:{...d,personIds:ids,...(d.request?{request:{...d.request,personIds:ids}}:{})}}});
 await page.goto(`/campaigns/${id}`);const people=page.locator('section',{has:page.getByRole('heading',{name:/^People \d/})});await expect(people.getByRole('heading')).toHaveText('People 60');
 await expect(people.getByText('1–50 of 60')).toBeVisible();await expect(people.locator('tbody tr')).toHaveCount(50);await expect(people.getByText('Page 1 of 2')).toBeVisible();
 await people.getByRole('link',{name:'Next',exact:true}).click();await expect(people.getByText('51–60 of 60')).toBeVisible();await expect(people.locator('tbody tr')).toHaveCount(10);
 await people.getByRole('link',{name:'Previous',exact:true}).click();await expect(people.getByText('1–50 of 60')).toBeVisible();
 // Search narrows the list and the pages with it.
 await people.getByLabel('Search people in the campaign').fill('X05');await people.getByLabel('Search people in the campaign').press('Enter');await expect(people.locator('tbody tr')).toHaveCount(1);await expect(people.getByText('Page 1 of 2')).toHaveCount(0);
});

test('the picker shows what is selected, with the filters back to default, and Tier sits in the first row',async({page})=>{
 await db.personCache.createMany({data:[0,1,2].map(i=>({id:`PickView-${i}`,firstName:'PickView',lastName:String(i+1),sortName:`pickview ${i+1}`,podOwner:'ALISA',email:`pickview${i}@outreach-test.example`,tier:i===0?'LEVEL_1':i===1?'LEVEL_2':null})),skipDuplicates:true});
 await login(page);await page.goto('/campaigns/new');await page.getByLabel('Campaign pod').selectOption({label:"Alisa's pod"});
 await expect(page.getByLabel('Filter by priority',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Filter by tier',{exact:true})).toBeVisible();await expect(page.getByLabel('Filter by contact type',{exact:true})).toHaveCount(0);
 await page.getByLabel('Search people to add').fill('PickView');await expect(page.getByText('3 matching')).toBeVisible();
 await page.getByLabel('Select PickView 1',{exact:true}).check();await page.getByLabel('Select PickView 2',{exact:true}).check();
 await page.getByLabel('Filter by tier',{exact:true}).selectOption('LEVEL_1');await expect(page.getByText('1 matching')).toBeVisible();
 await page.getByRole('button',{name:'2 selected',exact:true}).click();
 await expect(page.getByText('Showing the people you selected')).toBeVisible();await expect(page.getByLabel('Filter by tier',{exact:true})).toHaveValue('');await expect(page.getByLabel('Search people to add')).toHaveValue('');
 await expect(page.getByText('2 matching')).toBeVisible();await expect(page.getByLabel('Select PickView 3',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Select all matching',exact:true})).toHaveCount(0);
 // Unticking one here takes them out; the view follows the selection.
 await page.getByLabel('Select PickView 2',{exact:true}).uncheck();await expect(page.getByText('1 matching')).toBeVisible();
 await page.getByRole('button',{name:'Show everyone',exact:true}).click();await expect(page.getByRole('button',{name:'Select all matching',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'1 selected',exact:true}).click();await page.getByRole('button',{name:'Clear selection',exact:true}).click();await expect(page.getByText('Showing the people you selected')).toHaveCount(0);
});

test('on its start day a running campaign takes a new FO with their people, and nobody on it changes',async({page,browser})=>{
 test.setTimeout(300_000);
 const day=(offset:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago'}).format(new Date(Date.now()+offset*86400000));
 await login(page);await beginStudio(page,'JoinsToday',{startDate:day(0),endDate:day(14)});
 await page.getByRole('button',{name:'Next: Schedule'}).click();await page.getByRole('button',{name:'Publish campaign'}).click();await page.waitForURL(/\/campaigns\/[a-f0-9-]+$/);const id=page.url().split('/').at(-1)!;
 // The worker starts it within a minute of publishing.
 await expect.poll(async()=>(await db.campaign.findUniqueOrThrow({where:{id}})).status,{timeout:180_000,intervals:[2000]}).toBe('ACTIVE');
 const before=await db.enrollment.findMany({where:{campaignId:id},orderBy:{id:'asc'},select:{id:true,personId:true,foUserId:true,sequenceId:true,scheduleDates:true,status:true}});expect(before).toHaveLength(4);
 const karson=await db.user.findUniqueOrThrow({where:{email:'karson@cadence.local'}});
 await db.personCache.createMany({data:[0,1,2,3].map(i=>({id:`JoinsToday-k${i}`,firstName:'JoinsTodayK',lastName:String(i+1),sortName:`joinstodayk ${i+1}`,ownerMemberId:karson.twentyMemberId,podOwner:'ALISA',email:`joinstoday-k${i}@outreach-test.example`})),skipDuplicates:true});
 // An FO of the pod who is not a leader does not get the option.
 const fo=await browser.newPage();await login(fo,'karson@cadence.local');await fo.goto(`/campaigns/${id}`);await expect(fo.getByRole('heading',{name:'JoinsToday',exact:true})).toBeVisible();await expect(fo.getByRole('button',{name:'Add an FO'})).toHaveCount(0);await fo.close();
 await page.goto(`/campaigns/${id}`);const panel=page.getByRole('region',{name:'Add an FO'});
 await panel.getByRole('button',{name:'Add an FO'}).click();await panel.getByLabel('FO to add').selectOption({label:'Karson Junior'});
 await panel.getByLabel('Search people to add').fill('JoinsTodayK');await expect(panel.getByText('4 matching')).toBeVisible();await panel.getByRole('button',{name:'Select all matching',exact:true}).click();await expect(panel.getByRole('button',{name:'4 selected',exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'Preview',exact:true}).click();await expect(panel.getByRole('status').filter({hasText:'Karson Junior · 4 people'})).toBeVisible();
 await panel.getByRole('button',{name:'Add Karson Junior to this campaign',exact:true}).click();await expect(page.getByText('Karson Junior joined JoinsToday with 4 people.',{exact:false})).toBeVisible();
 const after=await db.enrollment.findMany({where:{campaignId:id},orderBy:{id:'asc'},select:{id:true,personId:true,foUserId:true,sequenceId:true,scheduleDates:true,status:true}});
 expect(after.filter(e=>e.foUserId!==karson.id)).toEqual(before);expect(after.filter(e=>e.foUserId===karson.id).map(e=>e.personId).sort()).toEqual(['JoinsToday-k0','JoinsToday-k1','JoinsToday-k2','JoinsToday-k3']);
 // The calendar now has Karson in its dropdown, and the page lists all eight people.
 await page.reload();await expect(page.getByLabel('Calendar FO').locator('option',{hasText:'Karson Junior'})).toHaveCount(1);await expect(page.getByRole('heading',{name:'People and progress'})).toBeVisible();await expect(page.locator('section',{has:page.getByRole('heading',{name:'People and progress'})}).locator('tbody tr')).toHaveCount(8);
 // A second FO joins straight after, without a reload: the list has moved on from Karson.
 const leigh=await db.user.findUniqueOrThrow({where:{email:'leigh@cadence.local'}});
 await db.personCache.createMany({data:[0,1,2].map(i=>({id:`JoinsToday-l${i}`,firstName:'JoinsTodayL',lastName:String(i+1),sortName:`joinstodayl ${i+1}`,ownerMemberId:leigh.twentyMemberId,podOwner:'ALISA',email:`joinstoday-l${i}@outreach-test.example`})),skipDuplicates:true});
 await panel.getByRole('button',{name:'Add an FO'}).click();await expect(panel.getByLabel('FO to add').locator('option',{hasText:'Karson Junior'})).toHaveCount(0);
 await panel.getByLabel('FO to add').selectOption({label:'Leigh Leader'});await panel.getByLabel('Search people to add').fill('JoinsTodayL');await expect(panel.getByText('3 matching')).toBeVisible();await panel.getByRole('button',{name:'Select all matching',exact:true}).click();await expect(panel.getByRole('button',{name:'3 selected',exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'Preview',exact:true}).click();await expect(panel.getByRole('status').filter({hasText:'Leigh Leader · 3 people'})).toBeVisible();
 await panel.getByRole('button',{name:'Add Leigh Leader to this campaign',exact:true}).click();await expect(page.getByText('Leigh Leader joined JoinsToday with 3 people.',{exact:false})).toBeVisible();
 expect(await db.enrollment.count({where:{campaignId:id,foUserId:leigh.id}})).toBe(3);expect((await db.enrollment.findMany({where:{campaignId:id,foUserId:{notIn:[karson.id,leigh.id]}},orderBy:{id:'asc'},select:{id:true,personId:true,foUserId:true,sequenceId:true,scheduleDates:true,status:true}}))).toEqual(before);
 // Its work is today's real work: end it, so later cases see their own tasks only.
 await db.task.updateMany({where:{enrollment:{campaignId:id},state:'PENDING'},data:{state:'CANCELLED'}});await db.enrollment.updateMany({where:{campaignId:id},data:{status:'EXITED',exitReason:'removed'}});await db.campaign.update({where:{id},data:{status:'STOPPED'}});
});
