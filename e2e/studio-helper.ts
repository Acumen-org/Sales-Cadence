import {PrismaClient} from '@prisma/client';
import {expect,type Page} from '@playwright/test';
export async function beginStudio(page: Page, label: string, options: {count?:number;endDate?:string}={}) {
 const db=new PrismaClient({datasourceUrl:'postgresql://postgres:postgres@localhost:5435/cadence'});
 const count=options.count??4;
 try {
  const fo=await db.user.findUniqueOrThrow({where:{email:'alisa@cadence.local'}});
  for(let i=0;i<count;i++)await db.personCache.upsert({where:{id:`${label}-${i}`},create:{id:`${label}-${i}`,firstName:label,lastName:String(i+1),sortName:`${label} ${i+1}`.toLowerCase(),ownerMemberId:fo.twentyMemberId,podOwner:'ALISA',email:`${label}${i}@outreach-test.example`,tags:i===0?['MIP']:[],tier:i===1?'LEVEL_1':null},update:{}});
 } finally {await db.$disconnect();}
 await page.goto('/campaigns/new');await page.getByLabel('Campaign name',{exact:true}).fill(label);
 await page.getByLabel('Campaign pod').selectOption({label:"Alisa's pod"});
 await page.getByLabel('Start date',{exact:true}).fill('2027-01-04');await page.getByLabel('End date',{exact:true}).fill(options.endDate??'2027-01-08');
 await page.getByRole('button',{name:'PHH',exact:true}).click();await page.getByLabel('Default new people per day').fill('1');await page.getByRole('checkbox',{name:'Alisa Senior',exact:true}).check();
 await page.getByLabel('Search people to add').fill(label);for(let i=1;i<=count;i++)await page.getByLabel(`Select ${label} ${i}`,{exact:true}).check();
 await page.getByRole('button',{name:'Next: Outreach',exact:true}).click();await expect(page.getByRole('heading',{name:'Outreach groups',exact:true})).toBeVisible();
}
